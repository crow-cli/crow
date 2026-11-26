import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { acpExtras, useAcpAgentCapabilities, useAcpSessionId } from "@assistant-ui/acp";
import { useAui, useAuiState } from "@assistant-ui/react";
import { ChatSession, ChatThread } from "@/components/chat-session";
import { ModelSelector } from "@/components/model-selector";
import { ContextGauge } from "@/components/context-meter";
import { collapseAll } from "@/lib/collapse-all";
import { parseMcpConfig } from "@/lib/mcp-config";
import "./index.css";
import "./vscode.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const settings = JSON.parse(document.getElementById("crow-acp-settings")!.textContent!) as {
  host: "editor" | "sidebar";
  endpoint: string;
  cwd: string;
  protocol: "auto" | "1" | "2";
  mcpConfig: string;
  mcpEndpoint?: string;
  attach?: { requestId: string; sessionId?: string };
};
// serve-web: the backend proxy runs on the server, not the browser's machine.
// On http(s) pages (self-hosted web) dial it via the host that served the page;
// desktop webviews keep loopback (their origin is vscode-webview://).
const endpoint = /^https?:$/.test(location.protocol)
  ? settings.endpoint.replace(/^(wss?:\/\/)(?:127\.0\.0\.1|localhost|\[::1\])(?=[:/])/, `$1${location.hostname}`)
  : settings.endpoint;
const mcp = parseMcpConfig(settings.mcpConfig);
// The backend's coordination tools ride the proxy's own port, which is minted
// per window — the extension hands it over so no static config can know it.
const mcpServers = settings.mcpEndpoint && !mcp.servers.some((s) => s.name === "crow-backend")
  ? [...mcp.servers, { type: "http" as const, name: "crow-backend", url: settings.mcpEndpoint, headers: [] }]
  : mcp.servers;

/**
 * Model and context ride the composer's action row instead of a footer, so the
 * thread gets every vertical pixel. Narrower than the standalone app's copy:
 * a sidebar has no room for the full-width selector.
 */
function ComposerStatus() {
  return (
    <>
      <ModelSelector className="max-w-40" />
      <ContextGauge />
    </>
  );
}

/**
 * The native half of the sidebar. The extension cannot ask the agent anything
 * itself, so this publishes the runtime's thread list over postMessage and
 * answers the extension's open/new/delete/refresh messages with store calls —
 * the same adapter the in-webview list used to drive.
 */
function VscodeBridge() {
  const aui = useAui();
  const items = useAuiState((s) => s.threads.threadItems);
  const ids = useAuiState((s) => s.threads.threadIds);
  const activeId = useAcpSessionId();
  const canDelete = useAcpAgentCapabilities()?.sessionCapabilities?.delete != null;
  // `threadItems` can carry the external store's placeholder main thread, which
  // is not a session the agent ever minted; `threadIds` is the agent's own list.
  // The QuickPick mirrors the agent, so it follows `threadIds` — and the memo
  // keeps the effect below from reposting on every render.
  const threads = useMemo(() => items.filter((item) => ids.includes(item.id)), [items, ids]);
  useEffect(() => {
    vscode.postMessage({
      type: "threads",
      activeId,
      canDelete,
      threads: threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        updatedAt: typeof thread.custom?.updatedAt === "string" ? thread.custom.updatedAt : undefined,
        isRunning: thread.isRunning,
      })),
    });
  }, [threads, activeId, canDelete]);
  // Headed delegation: the extension binds this pane to a session, then
  // delivers the prompt through the composer — the exact path a typed
  // message takes, so the turn is visible in this chat.
  // The runtime restores the latest session on connect; switching threads
  // before that finishes lets restore land afterwards and hijack the pane.
  const waitRuntimeReady = async () => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const extras = acpExtras.get(aui);
      if (extras.connectionState === "connected" && !aui.thread.getState().isLoading) return;
      if (Date.now() > deadline) throw new Error("chat runtime never finished loading");
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const whenReady = (fn: () => void | Promise<void>) => {
    void (async () => {
      try {
        await waitRuntimeReady();
        await fn();
      } catch (err) {
        console.error("[crow-acp] thread switch failed:", err);
      }
    })();
  };
  const attachAndReport = async (requestId: string, sessionId?: string) => {
    try {
      await waitRuntimeReady();
      if (sessionId) await aui.threads.switchToThread(sessionId);
      else await aui.threads.switchToNewThread();
      const sid = acpExtras.get(aui).sessionId;
      if (!sid) throw new Error("chat client has no session after attach");
      vscode.postMessage({ type: "prompt-attached", requestId, sessionId: sid });
    } catch (err) {
      vscode.postMessage({ type: "prompt-attach-failed", requestId, error: String(err) });
    }
  };
  const attachStarted = useRef(false);
  useEffect(() => {
    const attach = settings.attach;
    if (!attach || attachStarted.current) return;
    attachStarted.current = true;
    void attachAndReport(attach.requestId, attach.sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aui]);
  useEffect(() => {
    const onMessage = (event: MessageEvent<{ type?: string; id?: string; requestId?: string; sessionId?: string; text?: string }>) => {
      switch (event.data?.type) {
        case "switch-thread":
          if (event.data.id) whenReady(() => aui.threads.switchToThread(event.data.id!));
          break;
        case "new-thread":
          whenReady(() => aui.threads.switchToNewThread());
          break;
        case "delete-thread":
          if (event.data.id) aui.threads.item({ id: event.data.id }).delete();
          break;
        case "refresh-threads":
          void aui.threads.reload();
          break;
        case "collapse-all":
          collapseAll.toggle();
          break;
        case "prompt-attach":
          if (event.data.requestId) void attachAndReport(event.data.requestId, event.data.sessionId);
          break;
        case "prompt-send": {
          const { requestId, sessionId, text } = event.data;
          if (!requestId || typeof text !== "string") break;
          void (async () => {
            try {
              // The pane's own restore-on-connect may have landed on another
              // thread after attach reported; force the attached session.
              const deadline = Date.now() + 20000;
              for (;;) {
                if (sessionId && acpExtras.get(aui).sessionId !== sessionId) {
                  await aui.threads.switchToThread(sessionId);
                }
                aui.composer.setText(text);
                if (aui.composer.getState().canSend) break;
                if (Date.now() > deadline) throw new Error("composer never became ready to send");
                await new Promise((r) => setTimeout(r, 100));
              }
              aui.composer.send();
              vscode.postMessage({ type: "prompt-sent", requestId });
            } catch (err) {
              vscode.postMessage({ type: "prompt-send-failed", requestId, error: String(err) });
            }
          })();
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aui]);
  return null;
}

function App() {
  const [dark, setDark] = useState(() => !document.body.classList.contains("vscode-light") && !document.body.classList.contains("vscode-high-contrast-light"));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(!document.body.classList.contains("vscode-light") && !document.body.classList.contains("vscode-high-contrast-light")));
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  if (mcp.error) return <p role="alert">Invalid MCP configuration: {mcp.error}</p>;
  return (
    <div className={`${dark ? "dark" : ""} h-full`}>
      <ChatSession url={endpoint} cwd={settings.cwd} mcpServers={mcpServers} protocol={settings.protocol === "auto" ? "auto" : Number(settings.protocol) as 1 | 2}>
        {(error) => (
          <>
            <main aria-label="Crow ACP Chat" data-host={settings.host} className="crow-chat-layout flex h-full min-h-0 min-w-0 flex-col">
              {error && <p role="alert" className="text-destructive border-b px-3 py-1.5 text-xs">{error}</p>}
              <div className="min-h-0 flex-1"><ChatThread composerStatus={ComposerStatus} /></div>
            </main>
            <VscodeBridge />
          </>
        )}
      </ChatSession>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
