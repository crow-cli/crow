import { describe, test, expect, mock, afterEach } from "bun:test";

/**
 * Editor-pane chats are TABS: several may be open at once, each its own
 * client. This drives the real activate() and its registered commands against
 * a minimal vscode host stub (the `vscode` module only exists inside the IDE,
 * so the host API is the one thing that must be stood in for). The regression
 * it hunts: a singleton panel made `crowAcp.open` reveal the first pane
 * forever, so a second chat could never be opened in the editor.
 */

type Listener = (e: any) => void;
const disposable = (fn?: () => void) => ({ dispose: fn ?? (() => {}) });

function makePanel(viewType: string, title: string) {
  const messageListeners: Listener[] = [];
  const stateListeners: Listener[] = [];
  const disposeListeners: Listener[] = [];
  const posted: any[] = [];
  const panel = {
    viewType,
    title,
    active: false,
    reveals: 0,
    disposed: false,
    posted,
    webview: {
      options: {} as any,
      html: "",
      cspSource: "https://stub.invalid",
      asWebviewUri: (u: any) => ({ toString: () => String(u?.fsPath ?? u) }),
      onDidReceiveMessage(cb: Listener) { messageListeners.push(cb); return disposable(); },
      postMessage(msg: any) { posted.push(msg); return Promise.resolve(true); },
    },
    onDidChangeViewState(cb: Listener) { stateListeners.push(cb); return disposable(); },
    onDidDispose(cb: Listener) { disposeListeners.push(cb); return disposable(); },
    reveal() { panel.reveals++; },
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true;
      for (const cb of disposeListeners) cb(panel);
    },
    /** Simulate the workbench activating/deactivating this tab. */
    setActive(active: boolean) {
      panel.active = active;
      for (const cb of stateListeners) cb({ webviewPanel: panel });
    },
    receive(msg: any) { for (const cb of messageListeners) cb(msg); },
  };
  return panel;
}

const panels: ReturnType<typeof makePanel>[] = [];
const commands = new Map<string, (...args: any[]) => any>();
const config: Record<string, unknown> = {
  backend: "external",
  endpoint: "ws://127.0.0.1:9/acp",
  cwd: "/tmp/crow-pane-test",
};

const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath });

mock.module("vscode", () => ({
  ViewColumn: { Beside: 2 },
  QuickPickItemKind: { Separator: -1 },
  ThemeIcon: class { constructor(public id: string) {} },
  Disposable: class { constructor(private fn: () => void) {} dispose() { this.fn(); } },
  EventEmitter: class {
    private listeners: Listener[] = [];
    event = (cb: Listener) => { this.listeners.push(cb); return disposable(); };
    fire = (e: any) => { for (const cb of this.listeners) cb(e); };
    dispose = () => {};
  },
  Uri: { joinPath: (base: any, ...parts: string[]) => uri([base.fsPath, ...parts].join("/")) },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    createWebviewPanel: (viewType: string, title: string) => {
      const panel = makePanel(viewType, title);
      panels.push(panel);
      return panel;
    },
    registerWebviewViewProvider: () => disposable(),
    createQuickPick: () => { throw new Error("quick pick not expected in this test"); },
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (key: string) => config[key] }),
    onDidChangeConfiguration: () => disposable(),
    onDidChangeWorkspaceFolders: () => disposable(),
  },
  commands: {
    registerCommand: (name: string, fn: (...args: any[]) => any) => {
      commands.set(name, fn);
      return disposable(() => commands.delete(name));
    },
    executeCommand: (name: string, ...args: any[]) => commands.get(name)?.(...args),
  },
}));

const { activate } = await import("../../src/extension.js");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups.length = 0;
  panels.length = 0;
  commands.clear();
});

function boot() {
  const subscriptions: any[] = [];
  activate({ extensionUri: uri("/ext/crow-acp"), subscriptions } as any);
  cleanups.push(() => { for (const s of subscriptions) s.dispose?.(); });
  const open = () => commands.get("crowAcp.open")!();
  return { open, subscriptions };
}

describe("editor-pane chats", () => {
  test("crowAcp.open opens a NEW pane every time — chats are tabs, not a singleton", () => {
    const { open } = boot();
    open();
    open();
    open();
    expect(panels.length).toBe(3);
    expect(new Set(panels.map((p) => p.webview)).size).toBe(3);
    // None of them was a mere reveal of an earlier pane.
    expect(panels.every((p) => p.reveals === 0)).toBe(true);
  });

  test("editor title controls act on the ACTIVE tab, not the first one", () => {
    const { open } = boot();
    open();
    open();
    const [first, second] = panels;
    // The most recently opened tab is active; the new-session control must
    // reach it, not the first pane.
    second.setActive(true);
    commands.get("crowAcp.editor.session.new")!();
    expect(second.posted.some((m) => m.type === "new-thread")).toBe(true);
    expect(first.posted.some((m) => m.type === "new-thread")).toBe(false);
    // Focus the first tab: the control follows the active tab.
    first.setActive(true);
    second.setActive(false);
    commands.get("crowAcp.editor.session.new")!();
    expect(first.posted.filter((m) => m.type === "new-thread").length).toBe(1);
  });

  test("closing one chat leaves the others open and usable", () => {
    const { open } = boot();
    open();
    open();
    const [first, second] = panels;
    first.dispose();
    expect(second.disposed).toBe(false);
    second.setActive(true);
    commands.get("crowAcp.editor.session.new")!();
    expect(second.posted.some((m) => m.type === "new-thread")).toBe(true);
    // And a fresh chat still opens after one was closed.
    open();
    expect(panels.length).toBe(3);
    expect(panels[2].disposed).toBe(false);
  });
});
