/**
 * Focus retention for the composer during long runs.
 *
 * In a VS Code webview the iframe can lose focus to the workbench mid-run
 * (panel reveal / re-layout / overflow scroll); the composer's textarea is
 * blurred to <body> and keystrokes stop landing. assistant-ui only re-focuses
 * on run-start / scroll-to-bottom / thread-switch, so a blur that lands between
 * those events is never repaired and the empty composer stays unfocused.
 *
 * This restores focus to the composer whenever focus falls to nothing
 * (<body>) while a run is in flight. It never steals focus from an element the
 * user deliberately focused (a button, a link, another input): only a
 * focus-less document is repaired.
 */
export type ComposerFocusOptions = {
  doc: Document;
  win: Window;
  isRunning: () => boolean;
  composer: () => HTMLTextAreaElement | null;
};

export function retainComposerFocus(opts: ComposerFocusOptions): () => void {
  const restore = () => {
    if (!opts.isRunning()) return;
    const active = opts.doc.activeElement;
    if (active && active !== opts.doc.body && active !== opts.doc.documentElement) return;
    const el = opts.composer();
    if (el && !el.disabled) el.focus({ preventScroll: true });
  };
  // Let the blur settle before inspecting activeElement.
  const onFocusOut = () => setTimeout(restore, 0);
  const onWindowFocus = () => restore();
  opts.doc.addEventListener("focusout", onFocusOut, true);
  opts.win.addEventListener("focus", onWindowFocus);
  return () => {
    opts.doc.removeEventListener("focusout", onFocusOut, true);
    opts.win.removeEventListener("focus", onWindowFocus);
  };
}
