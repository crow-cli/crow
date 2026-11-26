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

// -- minimal tab-group host -------------------------------------------------
// Models enough of window.tabGroups for the extension's split/move logic:
// active group/tab tracking, group opens, and the workbench's native split
// (which skips singleton webview inputs and therefore opens an EMPTY group).
class TabInputWebview { constructor(public viewType: string) {} }
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
type HostTab = { input: TabInputWebview; isActive: boolean };
type HostGroup = { viewColumn: number; tabs: HostTab[]; isActive: boolean };
const groups: HostGroup[] = [];
const panelColumns: number[] = [];
const tabGroupListeners: Listener[] = [];
const tabListeners: Listener[] = [];
let nextColumn = 1;
const activeGroup = () => groups.find((g) => g.isActive);
const fireTabGroups = (e: any) => { for (const cb of [...tabGroupListeners]) cb(e); };
const fireTabs = (e: any) => { for (const cb of [...tabListeners]) cb(e); };
const groupApi = (g: HostGroup) => ({
  viewColumn: g.viewColumn, tabs: g.tabs, isActive: g.isActive,
  get activeTab() { return g.tabs.find((t) => t.isActive); },
});
function createGroup(viewColumn: number): HostGroup {
  const g: HostGroup = { viewColumn, tabs: [], isActive: false };
  groups.push(g);
  return g;
}
function openTab(group: HostGroup, viewType: string) {
  const tab: HostTab = { input: new TabInputWebview("mainThreadWebview-" + viewType), isActive: true };
  for (const t of group.tabs) t.isActive = false;
  group.tabs.push(tab);
  for (const g of groups) g.isActive = g === group;
  fireTabs({ opened: [tab], closed: [], changed: [] });
  fireTabGroups({ opened: [], closed: [], changed: [groupApi(group)] });
}
/** The workbench's native split of the active group: webview inputs are
    singletons, so the copy is skipped and an EMPTY group appears. */
function splitActiveGroup(): HostGroup {
  const src = activeGroup();
  const g = createGroup(nextColumn++);
  for (const x of groups) x.isActive = x === g;
  fireTabGroups({ opened: [groupApi(g)], closed: [], changed: src ? [groupApi(src)] : [] });
  return g;
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const settingsOf = (panel: any) => {
  const m = /<script id="crow-acp-settings" type="application\/json">([\s\S]*?)<\/script>/.exec(panel.webview.html);
  return m ? JSON.parse(m[1].replace(/\\u003c/g, "<")) : null;
};

mock.module("vscode", () => ({
  ViewColumn,
  UIKind: { Desktop: 1, Web: 2 },
  env: { uiKind: 1 },
  TabInputWebview,
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
    createWebviewPanel: (viewType: string, title: string, column: number) => {
      const panel = makePanel(viewType, title);
      panels.push(panel);
      panelColumns.push(column);
      let group: HostGroup;
      let isNew = false;
      if (column === ViewColumn.Active) { group = activeGroup() ?? createGroup(nextColumn++); isNew = !activeGroup(); }
      else if (column === ViewColumn.Beside) { group = createGroup(nextColumn++); isNew = true; }
      else { group = groups.find((g) => g.viewColumn === column) ?? createGroup(column); isNew = !groups.includes(group); }
      openTab(group, viewType);
      if (isNew) fireTabGroups({ opened: [groupApi(group)], closed: [], changed: [] });
      return panel;
    },
    registerWebviewViewProvider: () => disposable(),
    createQuickPick: () => { throw new Error("quick pick not expected in this test"); },
    showWarningMessage: async () => undefined,
    tabGroups: {
      get activeTabGroup() { const g = activeGroup(); return g ? groupApi(g) : undefined; },
      get all() { return groups.map(groupApi); },
      onDidChangeTabGroups: (cb: Listener) => { tabGroupListeners.push(cb); return disposable(() => { const i = tabGroupListeners.indexOf(cb); if (i >= 0) tabGroupListeners.splice(i, 1); }); },
      onDidChangeTabs: (cb: Listener) => { tabListeners.push(cb); return disposable(() => { const i = tabListeners.indexOf(cb); if (i >= 0) tabListeners.splice(i, 1); }); },
    },
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (key: string) => config[key] }),
    getWorkspaceFolder: () => undefined,
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
  groups.length = 0;
  panelColumns.length = 0;
  tabGroupListeners.length = 0;
  tabListeners.length = 0;
  nextColumn = 1;
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

  test("move-to-editor inserts into the active group, not a new split", async () => {
    const { open } = boot();
    open();
    await tick();
    const before = groups.length;
    commands.get("crowAcp.open")!("sess-1");
    await tick();
    expect(groups.length).toBe(before);
    expect(panelColumns[panelColumns.length - 1]).toBe(ViewColumn.Active);
    const s = settingsOf(panels[panels.length - 1]);
    expect(s.attach.sessionId).toBe("sess-1");
  });

  test("native split on a chat fills the empty group with a NEW session", async () => {
    const { open } = boot();
    open();
    await tick();
    const g2 = splitActiveGroup();
    await tick();
    expect(g2.tabs.length).toBe(1);
    const s = settingsOf(panels[panels.length - 1]);
    expect(s.attach).toBeTruthy();
    expect(s.attach.sessionId).toBeUndefined();
  });

  test("splitting a non-chat group does not spawn a chat", async () => {
    boot();
    const g = createGroup(nextColumn++);
    g.tabs.push({ input: { uri: "file:///x" } as any, isActive: true });
    for (const x of groups) x.isActive = x === g;
    fireTabs({ opened: [], closed: [], changed: [] });
    const g2 = splitActiveGroup();
    await tick();
    expect(g2.tabs.length).toBe(0);
    expect(panels.length).toBe(0);
  });
});
