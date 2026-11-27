import { describe, test, expect, mock, afterEach } from "bun:test";
import { Window as HappyWindow } from "happy-dom";

/**
 * The red error bubble: a turn that ended in error renders its text in an
 * alert-styled bubble with a copy button top right. The regression this
 * hunts: a crashed turn shown as ordinary reply text (no bubble), or a copy
 * button that copies the wrong thing / nothing.
 *
 * Boundary mock (justified): `useMessageError` reads the live assistant-ui
 * store, which needs a runtime; the reducer tests already prove the error
 * text reaches `status.error`. Everything else — ErrorPrimitive, the copy
 * hook, the button — is real.
 */
const realCoreReact = await import("@assistant-ui/core/react");

let currentError: unknown = "boom: the turn crashed";
mock.module("@assistant-ui/core/react", () => ({
  ...realCoreReact,
  useMessageError: () => currentError,
}));

const { MessageError } = await import("./message-error.aui");

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

async function mount() {
  const win = installDom();
  const doc = win.document;
  const copied: string[] = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as any);
  await act(async () => {
    root.render(<MessageError />);
  });
  return { win, doc, copied, root, act };
}

afterEach(() => {
  restoreDom();
  currentError = "boom: the turn crashed";
});

describe("MessageError red bubble", () => {
  test("renders the error text in a destructive-styled alert", async () => {
    const { doc, root, act } = await mount();
    const bubble = doc.querySelector('[role="alert"]');
    expect(bubble).toBeTruthy();
    expect(bubble!.className).toContain("border-destructive");
    expect(bubble!.textContent).toContain("boom: the turn crashed");
    await act(async () => root.unmount());
  });

  test("copy button sits top right and copies the full error text", async () => {
    currentError = "agent error: line one\nline two\nline three";
    const { win, doc, copied, root, act } = await mount();
    const button = doc.querySelector("button");
    expect(button).toBeTruthy();
    expect(button!.className).toContain("absolute");
    expect(button!.className).toContain("top-1.5");
    expect(button!.className).toContain("right-1.5");
    expect(button!.textContent).toContain("Copy error");

    await act(async () => {
      button!.dispatchEvent(new (win as any).MouseEvent("click", { bubbles: true }));
      await tick();
    });
    expect(copied).toEqual(["agent error: line one\nline two\nline three"]);
    await act(async () => root.unmount());
  });

  test("renders nothing when the message has no error", async () => {
    currentError = undefined;
    const { doc, root, act } = await mount();
    expect(doc.querySelector('[role="alert"]')).toBeNull();
    expect(doc.querySelector("button")).toBeNull();
    await act(async () => root.unmount());
  });
});
