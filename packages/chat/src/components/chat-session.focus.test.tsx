import { describe, test, expect, mock, afterEach } from "bun:test";
import { Window as HappyWindow } from "happy-dom";

/**
 * Regression hunt for the composer focus-retention steal.
 *
 * While a run is in flight, focus can legitimately leave the chat webview — the
 * user clicks another editor split, another pane, or the workbench. The iframe
 * then reports `activeElement === <body>` and `document.hasFocus() === false`.
 * The composer must NOT yank focus back: doing so routes every keystroke in the
 * IDE into the chat conductor and dismisses editor context menus.
 *
 * This renders the REAL `ChatThread` (the component both the sidebar and the
 * editor pane mount) against a happy-dom document and drives the exact
 * focus-leaving sequence. It fails while `retainComposerFocus` is wired in and
 * passes once that wiring is reverted. It imports only `chat-session`, so it
 * survives the deletion of `composer-focus.ts`.
 *
 * Boundary mocks (justified): `useAui`/`useAcpRuntime` need a live ACP socket and
 * runtime; `Thread` pulls the whole markdown/mermaid/highlighter rendering stack
 * and reads runtime context. The composer is reproduced with the SAME
 * `aria-label="Message input"` contract the real Thread renders, which is the
 * selector the retention effect queries. Everything else stays real.
 */
const realReact = await import("@assistant-ui/react");
const realAcp = await import("@assistant-ui/acp");

const auiStub = { thread: { getState: () => ({ isRunning: true }) } };

mock.module("@assistant-ui/react", () => ({
  ...realReact,
  useAui: () => auiStub,
  useAssistantDataUI: () => {},
}));
mock.module("@assistant-ui/acp", () => ({
  ...realAcp,
  useAcpSessionId: () => "test-session",
  useAcpRuntime: () => ({}),
}));
mock.module("@/components/assistant-ui/elements/thread.aui", () => ({
  Thread: () => <textarea aria-label="Message input" />,
}));
mock.module("@/components/collapse-aware-reasoning", () => ({
  CollapseAwareReasoningGroup: () => null,
}));
mock.module("@/components/compaction-card", () => ({ COMPACTION_DATA_UI: {} }));
mock.module("@/components/tools/acp-tool-card", () => ({ AcpToolCard: () => null }));

const { ChatThread } = await import("./chat-session");

const DOM_GLOBALS = [
  "window", "document", "navigator", "HTMLElement", "HTMLInputElement",
  "HTMLTextAreaElement", "Element", "Node", "Text", "Comment", "DocumentFragment",
  "SVGElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "MutationObserver", "Event", "CustomEvent", "FocusEvent", "KeyboardEvent",
  "MouseEvent", "PointerEvent", "InputEvent", "history", "location",
] as const;

const saved = new Map<string, unknown>();

function installDom() {
  const win = new HappyWindow({ url: "http://localhost/" });
  for (const key of DOM_GLOBALS) {
    if (!saved.has(key)) saved.set(key, (globalThis as any)[key]);
    const value = (win as any)[key];
    if (value !== undefined) (globalThis as any)[key] = value;
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  return win;
}

function restoreDom() {
  for (const [key, value] of saved) {
    if (value === undefined) delete (globalThis as any)[key];
    else (globalThis as any)[key] = value;
  }
  saved.clear();
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// happy-dom's element types and the DOM-lib types are distinct to TS; compare
// identity through `unknown` so the check is allowed without weakening it.
const sameEl = (a: unknown, b: unknown) => a === b;

async function mount() {
  const win = installDom();
  const doc = win.document;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as any);
  await act(async () => {
    root.render(<ChatThread />);
  });
  const composer = doc.querySelector(
    'textarea[aria-label="Message input"]',
  ) as unknown as HTMLTextAreaElement;
  return { win, doc, composer, root, act };
}

afterEach(() => {
  restoreDom();
});

describe("ChatThread does not steal focus when it leaves the webview mid-run", () => {
  test("focusout to <body> while the document is unfocused must not refocus the composer", async () => {
    const { win, doc, composer, root, act } = await mount();
    expect(composer).toBeTruthy();

    composer.focus();
    expect(sameEl(doc.activeElement, composer)).toBe(true);

    // Focus legitimately leaves the webview (user clicked another editor split).
    (doc as any).hasFocus = () => false;
    composer.blur();
    doc.dispatchEvent(new (win as any).FocusEvent("focusout", { bubbles: true }));
    await tick();

    expect(doc.hasFocus()).toBe(false);
    expect(sameEl(doc.activeElement, composer)).toBe(false);

    await act(async () => root.unmount());
  });

  test("a window focus event while the document is unfocused must not focus the composer", async () => {
    const { win, doc, composer, root, act } = await mount();
    (doc as any).hasFocus = () => false;
    expect(sameEl(doc.activeElement, composer)).toBe(false);

    win.dispatchEvent(new (win as any).Event("focus"));
    await tick();

    expect(sameEl(doc.activeElement, composer)).toBe(false);

    await act(async () => root.unmount());
  });
});
