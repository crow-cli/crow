import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Settings2Icon } from "lucide-react";
import { useAcpConnectionState, useAcpSessionTitle } from "@assistant-ui/acp";
import { ChatSession, ChatThread } from "@/components/chat-session";
import { ContextGauge } from "@/components/context-meter";
import { ModelSelector } from "@/components/model-selector";
import { SettingsDialog } from "@/components/settings-dialog";
import { ThreadSidebar } from "@/components/thread-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { parseMcpConfig } from "@/lib/mcp-config";
import {
  endpointOf,
  readSettings,
  saveSettings,
  SETTINGS_SCRIPT_ID,
  type ResolvedSettings,
  type WebSettings,
} from "@/lib/web-settings";
import "./index.css";

/**
 * The browser host — `vscode.tsx`'s sibling, and the reason `ChatSession` never
 * knew where it was running.
 *
 * Three things differ from the editor, and all three are about who supplies
 * what:
 *
 * 1. **Settings.** The extension injects a JSON blob into the webview's HTML;
 *    a page reads the same blob when the agent serves it (`SETTINGS_SCRIPT_ID`,
 *    the identical id) and otherwise falls back to the URL query and
 *    localStorage. `lib/web-settings` owns the precedence.
 * 2. **Sessions.** VS Code puts the session menu on the view title, so
 *    `vscode.tsx` publishes the runtime's thread list over postMessage and the
 *    native half mirrors it into a QuickPick. Here `ThreadSidebar` reads the
 *    same runtime state directly — no bridge, because there is nothing on the
 *    other side of one.
 * 3. **Theme.** The webview follows the workbench's body classes; a page owns
 *    the choice, so `ThemeToggle` drives `lib/theme`'s `useTheme`.
 *
 * Everything else — the thread, the tool cards, the composer, the queue,
 * compaction, markdown — is `@crow/chat`, unchanged. There is no `vscode.css`
 * here and no `acquireVsCodeApi` anywhere in this file.
 */

const browser = typeof window !== "undefined" && typeof document !== "undefined";
const storage = browser ? window.localStorage : null;
const pageOrigin = browser ? window.location.origin : undefined;

const initial: ResolvedSettings = readSettings({
  search: browser ? window.location.search : "",
  storage,
  injected: browser ? (document.getElementById(SETTINGS_SCRIPT_ID)?.textContent ?? null) : null,
  origin: pageOrigin,
});

/** The full-width action row: a page has the room the sidebar does not. */
function ComposerStatus() {
  return (
    <>
      <ModelSelector />
      <ContextGauge />
    </>
  );
}

const DOT: Record<string, string> = {
  connected: "bg-success",
  connecting: "bg-warning animate-pulse",
  disconnected: "bg-muted-foreground/50",
};

/** The header row. Inside `ChatSession`, because the connection state and the
 *  session title are the runtime's, not the page's. */
function Chrome({ endpoint, onOpenSettings }: { endpoint: string; onOpenSettings(): void }) {
  const state = useAcpConnectionState();
  const title = useAcpSessionTitle();
  return (
    <header className="flex items-center gap-2 border-b px-3 py-1.5" data-testid="chrome">
      <span
        aria-hidden
        data-testid="connection-dot"
        data-state={state}
        className={`size-2 shrink-0 rounded-full ${DOT[state] ?? DOT.disconnected}`}
      />
      <span className="text-muted-foreground truncate font-mono text-xs" data-testid="endpoint" title={endpoint}>
        {title || endpoint}
      </span>
      <span className="text-muted-foreground shrink-0 text-[11px]" data-testid="connection-state">
        {state}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
        <Button
          variant="ghost"
          size="sm"
          data-testid="open-settings"
          aria-label="Settings"
          title="Settings"
          className="size-7 p-0"
          onClick={onOpenSettings}
        >
          <Settings2Icon aria-hidden className="size-4" />
        </Button>
      </div>
    </header>
  );
}

function App() {
  const [resolved, setResolved] = useState<ResolvedSettings>(initial);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { settings, warnings, error } = resolved;
  const mcp = useMemo(() => parseMcpConfig(settings.mcpConfig), [settings.mcpConfig]);
  const endpoint = endpointOf(settings, pageOrigin);
  const save = useCallback((next: WebSettings) => {
    saveSettings(storage, next);
    // Re-read rather than adopt `next`: storage is the source of truth from here
    // on, and a field the user cleared has to come back as the default.
    setResolved(readSettings({ storage, injected: null, origin: pageOrigin }));
    setSettingsOpen(false);
  }, []);
  // A different endpoint, directory, protocol or tool supply is a different
  // agent, so the session is remounted rather than asked to move: `key` is the
  // only remount guarantee React gives, and a half-migrated runtime is a
  // thread that shows one agent's history over another's connection.
  const sessionKey = JSON.stringify([endpoint, settings.cwd, settings.protocol, mcp.servers]);

  if (mcp.error) {
    return (
      <p role="alert" className="p-4 text-sm">
        Invalid MCP configuration: {mcp.error}
      </p>
    );
  }

  return (
    <div className="h-full">
      <ChatSession
        key={sessionKey}
        url={endpoint}
        cwd={settings.cwd}
        mcpServers={mcp.servers}
        protocol={settings.protocol === "auto" ? "auto" : (Number(settings.protocol) as 1 | 2)}
      >
        {(sessionError) => (
          <div className="flex h-full min-h-0">
            <ThreadSidebar />
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
              <Chrome endpoint={endpoint} onOpenSettings={() => setSettingsOpen(true)} />
              {(error ?? sessionError) && (
                <p role="alert" className="text-destructive border-b px-3 py-1.5 text-xs" data-testid="session-error">
                  {error ?? sessionError}
                </p>
              )}
              <main aria-label="Crow chat" data-host="web" className="crow-chat-layout flex h-full min-h-0 min-w-0 flex-col">
                <div className="min-h-0 flex-1">
                  <ChatThread composerStatus={ComposerStatus} />
                </div>
              </main>
            </div>
          </div>
        )}
      </ChatSession>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        warnings={warnings}
        onSave={save}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
