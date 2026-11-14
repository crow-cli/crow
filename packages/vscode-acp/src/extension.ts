import * as vscode from "vscode";
import { Backend, type ClientBridge } from "./backend.js";

type SessionRow = { id: string; title?: string; updatedAt?: string; isRunning: boolean };
type SessionState = { rows: SessionRow[]; activeId?: string; canDelete: boolean };

function relativeTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One row of the session dropdown: a session, or the new-session action. */
type SessionItem = vscode.QuickPickItem & { row?: SessionRow; isNew?: boolean };

const DELETE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete Session" };

/**
 * The dropdown's contents. The chat webview owns the only ACP connection, so it
 * posts its runtime's thread list and this mirrors it into a quick pick — the
 * session menu lives in the view title, on the same row VS Code puts Copilot's
 * actions, instead of a second view stacked under the chat.
 */
function sessionItems(state: SessionState): SessionItem[] {
  const items: SessionItem[] = [{ label: "New Session", iconPath: new vscode.ThemeIcon("add"), isNew: true }];
  if (state.rows.length) items.push({ label: "Sessions", kind: vscode.QuickPickItemKind.Separator });
  for (const row of state.rows) {
    const active = row.id === state.activeId;
    items.push({
      label: row.title || row.id,
      description: [active ? "active" : undefined, relativeTime(row.updatedAt)].filter(Boolean).join(" · "),
      detail: row.id,
      iconPath: new vscode.ThemeIcon(row.isRunning ? "sync~spin" : active ? "comment-discussion" : "comment"),
      buttons: state.canDelete ? [DELETE_BUTTON] : [],
      row,
    });
  }
  return items;
}

function promptText(prompt: unknown): string {
  const blocks = typeof prompt === "string" ? [{ type: "text", text: prompt }] : Array.isArray(prompt) ? prompt : [];
  const text = blocks
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
  if (!text) throw new Error("headed prompt needs text content");
  return text;
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Crow ACP");
  const startupConfig = vscode.workspace.getConfiguration("crowAcp");
  let backendError: string | undefined;
  let panel: vscode.WebviewPanel | undefined;
  type ChatEntry = { host: "editor" | "sidebar"; cleanup: vscode.Disposable; sessions: SessionState; panel?: vscode.WebviewPanel };
  const webviews = new Map<vscode.Webview, ChatEntry>();
  /** The active editor chat tab: the editor/title controls sit above it, so
   * they act on it. Sidebar controls never consult this. */
  let activeEditorChat: vscode.Webview | undefined;
  /** Fires with the webview whose thread list just changed, so an open
   * dropdown re-renders against the agent's answer instead of going stale. */
  const sessionsChanged = new vscode.EventEmitter<vscode.Webview>();
  const root = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");

  // -- headed delegation bridge -------------------------------------------
  // crow_prompt must land in a VISIBLE chat: the prompt goes through the
  // webview's own ACP connection (composer.setText + send), never a headless
  // control request. attach binds a pane to the session first and reports
  // its sessionId; only then does send deliver the prompt.
  type AttachWaiter = { resolve: (sessionId: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };
  const attachWaiters = new Map<string, AttachWaiter>();
  const sendWaiters = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const attachedClients = new Map<string, vscode.Webview>();
  const panelAttach = new Map<vscode.Webview, { requestId: string; sessionId?: string }>();
  let requestSeq = 0;
  const nextRequestId = () => `crow-${++requestSeq}-${Date.now()}`;

  /** The called agent's own pane: an editor chat ACTIVE on the session.
      Every client mirrors the agent's full session list, so list membership
      proves nothing — matching on it let delegation hijack whichever client
      registered (or refreshed) first, sidebar included. Delegation never
      reuses the sidebar and never switches a pane that is not already the
      called session's own; otherwise it opens a fresh editor pane. */
  function webviewForSession(sessionId: string): vscode.Webview | undefined {
    for (const [webview, entry] of webviews)
      if (entry.host === "editor" && entry.sessions.activeId === sessionId) return webview;
    return undefined;
  }
  /** Any client ACTIVE on the session — delegation results go home to the
      caller's own client, sidebar included; editor panes win ties. */
  function activeOwnerWebview(sessionId: string): vscode.Webview | undefined {
    let fallback: vscode.Webview | undefined;
    for (const [webview, entry] of webviews) {
      if (entry.sessions.activeId !== sessionId) continue;
      if (entry.host === "editor") return webview;
      fallback ??= webview;
    }
    return fallback;
  }
  function openChatPane(attach: { requestId: string; sessionId?: string }): void {
    const pane = vscode.window.createWebviewPanel("crowAcp.chat", "Crow ACP Chat", vscode.ViewColumn.Beside, {
      retainContextWhenHidden: true,
    });
    panel = pane;
    panelAttach.set(pane.webview, attach);
    configure(pane, "editor");
  }
  const clientBridge: ClientBridge = {
    attach(sessionId) {
      const requestId = nextRequestId();
      const promise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          attachWaiters.delete(requestId);
          reject(new Error("chat client did not attach within 30s"));
        }, 30000);
        attachWaiters.set(requestId, { resolve, reject, timer });
      });
      const owner = sessionId ? webviewForSession(sessionId) : undefined;
      if (owner) void owner.postMessage({ type: "prompt-attach", requestId, sessionId });
      else openChatPane({ requestId, sessionId });
      return promise;
    },
    async send(sessionId, prompt) {
      const webview = attachedClients.get(sessionId) ?? activeOwnerWebview(sessionId);
      if (!webview) throw new Error(`no visible chat client attached for session ${sessionId}`);
      const text = promptText(prompt);
      const requestId = nextRequestId();
      const ack = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sendWaiters.delete(requestId);
          reject(new Error("chat client did not accept the prompt within 15s"));
        }, 15000);
        sendWaiters.set(requestId, { resolve, reject, timer });
      });
      void webview.postMessage({ type: "prompt-send", requestId, sessionId, text });
      await ack;
    },
  };

  const backend = new Backend({
    log: (line) => output.appendLine(line),
    cliCommand: startupConfig.get<string[]>("cliCommand") ?? ["crow-cli"],
    firstPort: startupConfig.get<number>("port") ?? 2771,
    external: startupConfig.get<string>("backend") === "external" ? startupConfig.get<string>("endpoint") : undefined,
    extraArgs: startupConfig.get<string>("model") ? ["--model", startupConfig.get<string>("model")!] : undefined,
    clientBridge,
  });
  function render(webview: vscode.Webview, host: "editor" | "sidebar") {
    const config = vscode.workspace.getConfiguration("crowAcp");
    const folder = vscode.window.activeTextEditor
      ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
      : undefined;
    const cwd = config.get<string>("cwd") || (folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
    if (!cwd) {
      webview.html = '<html><body><p>Open a workspace folder or set <code>crowAcp.cwd</code> to use Crow ACP Chat.</p></body></html>';
      return;
    }
    const endpoint = backend.endpoint;
    if (!endpoint) {
      const note = backendError
        ? `Crow backend failed to start: ${backendError.replace(/</g, "&lt;")} See the "Crow ACP" output channel.`
        : "Starting Crow backend\u2026";
      webview.html = `<html><body><p>${note}</p></body></html>`;
      return;
    }
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, file));
    const settings = JSON.stringify({
      host,
      endpoint,
      cwd,
      protocol: config.get<string>("protocol"),
      mcpConfig: config.get<string>("mcpConfig"),
      mcpEndpoint: backend.mcpEndpoint,
      attach: panelAttach.get(webview),
    }).replace(/</g, "\\u003c");
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    webview.html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} data: blob:; connect-src ws: wss:;">
<base href="${uri("")}/"><link rel="stylesheet" href="${uri("chat.css")}">
<title>Crow ACP Chat</title></head><body>
<script id="crow-acp-settings" type="application/json">${settings}</script>
<div id="root"></div><script nonce="${nonce}" type="module" src="${uri("chat.js")}"></script>
</body></html>`;
  }
  function configure(owner: vscode.WebviewPanel | vscode.WebviewView, host: "editor" | "sidebar") {
    const webview = owner.webview;
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    const focusTrackers: vscode.Disposable[] = [];
    if (host === "editor") {
      const pane = owner as vscode.WebviewPanel;
      activeEditorChat = webview;
      focusTrackers.push(pane.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) activeEditorChat = webview;
        else if (activeEditorChat === webview) activeEditorChat = undefined;
      }));
    }
    const listener = webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      const payload = message as { type: unknown; threads?: unknown; activeId?: unknown; canDelete?: unknown; requestId?: unknown; sessionId?: unknown; error?: unknown };
      if (payload.type === "settings") {
        void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:crow-ai.crow-acp");
      } else if (payload.type === "prompt-attached" && typeof payload.requestId === "string" && typeof payload.sessionId === "string") {
        const waiter = attachWaiters.get(payload.requestId);
        if (waiter) {
          clearTimeout(waiter.timer);
          attachWaiters.delete(payload.requestId);
          attachedClients.set(payload.sessionId, webview);
          panelAttach.delete(webview);
          waiter.resolve(payload.sessionId);
        }
      } else if (payload.type === "prompt-attach-failed" && typeof payload.requestId === "string") {
        const waiter = attachWaiters.get(payload.requestId);
        if (waiter) {
          clearTimeout(waiter.timer);
          attachWaiters.delete(payload.requestId);
          waiter.reject(new Error(typeof payload.error === "string" ? payload.error : "chat attach failed"));
        }
      } else if (payload.type === "prompt-sent" && typeof payload.requestId === "string") {
        const waiter = sendWaiters.get(payload.requestId);
        if (waiter) {
          clearTimeout(waiter.timer);
          sendWaiters.delete(payload.requestId);
          waiter.resolve();
        }
      } else if (payload.type === "prompt-send-failed" && typeof payload.requestId === "string") {
        const waiter = sendWaiters.get(payload.requestId);
        if (waiter) {
          clearTimeout(waiter.timer);
          sendWaiters.delete(payload.requestId);
          waiter.reject(new Error(typeof payload.error === "string" ? payload.error : "chat send failed"));
        }
      } else if (payload.type === "threads" && Array.isArray(payload.threads)) {
        entry.sessions = {
          rows: payload.threads as SessionRow[],
          activeId: typeof payload.activeId === "string" ? payload.activeId : undefined,
          canDelete: payload.canDelete === true,
        };
        sessionsChanged.fire(webview);
      }
    });
    const disposal = owner.onDidDispose(() => {
      if (host === "editor") panel = undefined;
      cleanup.dispose();
    });
    const cleanup = new vscode.Disposable(() => {
      listener.dispose();
      disposal.dispose();
      for (const t of focusTrackers) t.dispose();
      webviews.delete(webview);
      panelAttach.delete(webview);
      if (activeEditorChat === webview) activeEditorChat = undefined;
      for (const [sid, wv] of attachedClients) if (wv === webview) attachedClients.delete(sid);
    });
    const entry: ChatEntry = { host, cleanup, sessions: { rows: [], canDelete: false }, panel: host === "editor" ? (owner as vscode.WebviewPanel) : undefined };
    webviews.set(webview, entry);
    render(webview, host);
  }
  function renderAll() {
    for (const [webview, { host }] of webviews) render(webview, host);
  }
  /** Controls act on the client they sit above: sidebar menus resolve the
      sidebar webview, editor/title menus resolve the active editor chat tab. */
  function sidebarWebview(): vscode.Webview | undefined {
    for (const [webview, { host }] of webviews) if (host === "sidebar") return webview;
    return undefined;
  }
  function editorWebview(): vscode.Webview | undefined {
    if (activeEditorChat && webviews.has(activeEditorChat)) return activeEditorChat;
    for (const [webview, { host }] of webviews) if (host === "editor") return webview;
    return undefined;
  }
  function focusChat() {
    void vscode.commands.executeCommand("crowAcp.sidebar.focus");
  }
  /** One command set per host: the menus above a client invoke that client's
      set, so a control always acts on the client it sits above. */
  function chatCommands(prefix: string, resolve: () => vscode.Webview | undefined, focus: () => void) {
    return [
      vscode.commands.registerCommand(prefix + "session.new", () => {
        resolve()?.postMessage({ type: "new-thread" });
        focus();
      }),
      vscode.commands.registerCommand(prefix + "session.switch", () => {
        const webview = resolve();
        if (webview) pickSession(webview);
        else focus();
      }),
      vscode.commands.registerCommand(prefix + "collapseAll", () => {
        resolve()?.postMessage({ type: "collapse-all" });
      }),
      vscode.commands.registerCommand(prefix + "settings", () =>
        vscode.commands.executeCommand("workbench.action.openSettings", "@ext:crow-ai.crow-acp")),
    ];
  }
  /** The session dropdown behind the view title's history icon: new, switch
      and delete in one quick pick, live-updating while it is open. */
  function pickSession(webview: vscode.Webview) {
    const entry = webviews.get(webview);
    if (!entry) return;
    const pick = vscode.window.createQuickPick<SessionItem>();
    const sync = () => {
      const { rows, activeId } = entry.sessions;
      pick.items = sessionItems(entry.sessions);
      pick.placeholder = rows.length ? "Switch session, start a new one, or delete one" : "No sessions yet — start one";
      const title = rows.find((row) => row.id === activeId)?.title;
      pick.title = title ? `Crow Sessions — ${title}` : "Crow Sessions";
    };
    sync();
    pick.matchOnDescription = true;
    pick.buttons = [{ iconPath: new vscode.ThemeIcon("refresh"), tooltip: "Refresh Sessions" }];
    const changed = sessionsChanged.event((source) => {
      if (source === webview) sync();
    });
    pick.onDidTriggerButton(() => {
      void webview.postMessage({ type: "refresh-threads" });
    });
    pick.onDidTriggerItemButton(async ({ item }) => {
      if (!item.row) return;
      const answer = await vscode.window.showWarningMessage(
        `Delete session ${item.row.title || item.row.id}? The agent forgets it. This cannot be undone.`,
        { modal: true },
        "Delete",
      );
      if (answer === "Delete") void webview.postMessage({ type: "delete-thread", id: item.row.id });
    });
    pick.onDidAccept(() => {
      const [item] = pick.selectedItems;
      pick.hide();
      if (item?.isNew) void webview.postMessage({ type: "new-thread" });
      else if (item?.row && item.row.id !== entry.sessions.activeId) void webview.postMessage({ type: "switch-thread", id: item.row.id });
      if (entry.host === "sidebar") focusChat();
    });
    pick.onDidHide(() => {
      changed.dispose();
      pick.dispose();
    });
    pick.show();
  }
  context.subscriptions.push(
    output,
    backend,
    vscode.window.registerWebviewViewProvider("crowAcp.sidebar", {
      resolveWebviewView(view) {
        configure(view, "sidebar");
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("crowAcp.openSidebar", () =>
      vscode.commands.executeCommand("crowAcp.sidebar.focus")),
    ...chatCommands("crowAcp.", sidebarWebview, focusChat),
    ...chatCommands("crowAcp.editor.", editorWebview, () => {
      const webview = editorWebview();
      if (webview) webviews.get(webview)?.panel?.reveal();
      else void vscode.commands.executeCommand("crowAcp.open");
    }),
    vscode.commands.registerCommand("crowAcp.open", () => {
      if (panel) { panel.reveal(); activeEditorChat = panel.webview; return; }
      panel = vscode.window.createWebviewPanel("crowAcp.chat", "Crow ACP Chat", vscode.ViewColumn.Beside, {
        retainContextWhenHidden: true,
      });
      configure(panel, "editor");
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("crowAcp")) renderAll();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(renderAll),
    sessionsChanged,
    { dispose: () => {
      panel?.dispose();
      for (const { cleanup } of webviews.values()) cleanup.dispose();
    } },
  );
  void backend.start().then(
    () => renderAll(),
    (err: unknown) => {
      backendError = err instanceof Error ? err.message : String(err);
      output.appendLine(`[backend] start failed: ${backendError}`);
      renderAll();
    },
  );
}
