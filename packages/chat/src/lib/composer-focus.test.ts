import { describe, test, expect } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { retainComposerFocus } from "./composer-focus";

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(running: boolean) {
  const win = new HappyWindow();
  const doc = win.document;
  doc.body.innerHTML = '<textarea aria-label="Message input"></textarea><button type="button">b</button>';
  const composer = doc.querySelector("textarea")!;
  const button = doc.querySelector("button")!;
  const dispose = retainComposerFocus({
    doc: doc as unknown as Document,
    win: win as unknown as Window,
    isRunning: () => running,
    composer: () => composer as unknown as HTMLTextAreaElement,
  });
  const blurToBody = () => {
    composer.blur();
    doc.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }));
  };
  return { win, doc, composer, button, dispose, blurToBody };
}

describe("composer focus retention", () => {
  test("restores the composer when a long run blurs focus to <body>", async () => {
    const s = setup(true);
    s.composer.focus();
    expect(s.doc.activeElement).toBe(s.composer);
    s.blurToBody();
    await tick();
    expect(s.doc.activeElement).toBe(s.composer);
    s.dispose();
  });

  test("does not refocus when no run is in flight", async () => {
    const s = setup(false);
    s.composer.focus();
    s.blurToBody();
    await tick();
    expect(s.doc.activeElement).not.toBe(s.composer);
    s.dispose();
  });

  test("never steals focus from a deliberately focused element", async () => {
    const s = setup(true);
    s.button.focus();
    s.win.dispatchEvent(new (s.win as any).Event("focus"));
    await tick();
    expect(s.doc.activeElement).toBe(s.button);
    s.dispose();
  });

  test("stops restoring after dispose", async () => {
    const s = setup(true);
    s.dispose();
    s.composer.focus();
    s.blurToBody();
    await tick();
    expect(s.doc.activeElement).not.toBe(s.composer);
  });
});
