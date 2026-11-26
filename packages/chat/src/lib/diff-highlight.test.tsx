import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffViewer } from "@/components/ui/diff-viewer";
import { highlightLine, languageFromPath } from "@/lib/syntax-highlighter";
import PrismAsyncLight from "react-syntax-highlighter/dist/esm/prism-async-light";

const PY_PATCH = `--- a/foo.py
+++ b/foo.py
@@ -1,3 +1,3 @@
 import os
-def greet(name):
-    return "hi " + name
+def greet(name: str) -> str:
+    return f"hi {name}"
`;

describe("languageFromPath", () => {
  test("maps extensions to highlighter languages", () => {
    expect(languageFromPath("src/foo.py")).toBe("python");
    expect(languageFromPath("crates/crow/src/main.rs")).toBe("rust");
    expect(languageFromPath("a/b.tsx")).toBe("tsx");
    expect(languageFromPath("x/y.sh")).toBe("bash");
    expect(languageFromPath("README.md")).toBe("markdown");
  });
  test("unknown or missing extension is undefined", () => {
    expect(languageFromPath("Makefile")).toBeUndefined();
    expect(languageFromPath("foo.unknownext")).toBeUndefined();
    expect(languageFromPath(undefined)).toBeUndefined();
  });
});

describe("highlightLine", () => {
  test("tokenizes with the theme palette", () => {
    const html = renderToStaticMarkup(
      <>{highlightLine('def greet(name):', "python")}</>,
    );
    expect(html).toContain("var(--code-keyword)");
    expect(html).toContain("var(--code-function)");
    expect(html).toContain("greet");
  });
  test("plain text for unknown language", () => {
    expect(highlightLine("def greet(name):", undefined)).toBe("def greet(name):");
    expect(highlightLine("x", "not-a-language")).toBe("x");
  });
});

describe("DiffViewer syntax highlighting", () => {
  test("highlights add/del lines of a python patch, keeping diff colors", () => {
    const html = renderToStaticMarkup(<DiffViewer patch={PY_PATCH} />);
    expect(html).toContain('data-type="add"');
    expect(html).toContain('data-type="del"');
    expect(html).toContain("var(--code-keyword)");
    expect(html).toContain("var(--code-string)");
    // the diff's own add/del text variables survive alongside the tokens
    expect(html).toContain("--diff-add-bg");
  });
  test("rust patch highlights keywords", () => {
    const patch = `--- a/lib.rs
+++ b/lib.rs
@@ -1 +1 @@
-fn main() {}
+pub fn main() -> Result<(), String> { Ok(()) }
`;
    const html = renderToStaticMarkup(<DiffViewer patch={patch} />);
    expect(html).toContain("var(--code-keyword)");
  });
  test("unknown extension renders plain lines", () => {
    const patch = `--- a/notes.xyz
+++ b/notes.xyz
@@ -1 +1 @@
-old line
+new line
`;
    const html = renderToStaticMarkup(<DiffViewer patch={patch} />);
    expect(html).toContain("new line");
    expect(html).not.toContain("var(--code-keyword)");
  });
  test("explicit language overrides the extension", () => {
    const patch = `--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-x = 1
+def f(): pass
`;
    const html = renderToStaticMarkup(<DiffViewer patch={patch} language="python" />);
    expect(html).toContain("var(--code-keyword)");
  });
});

// The markdown fences (reasoning AND output, sidebar AND editor) all render
// through PrismAsyncLight. On session/load the whole transcript paints in one
// commit; if the Prism core only starts loading at the first fence's mount,
// that first paint is plain and only colorizes a tick later. Preloading at
// module evaluation closes that window. This hunts the regression where the
// generator load is deferred to mount (astGeneratorPromise still null here).
type AsyncInternals = {
  astGeneratorPromise: Promise<void> | null;
  astGenerator: unknown;
  isRegistered(language: string): boolean;
};
const prism = PrismAsyncLight as unknown as AsyncInternals;

describe("markdown fence highlighter readiness (session/load parity)", () => {
  test("the Prism core load is started at import, before any fence mounts", () => {
    expect(prism.astGeneratorPromise).not.toBeNull();
  });

  test("once settled, the generator is ready and fence languages are registered", async () => {
    await prism.astGeneratorPromise;
    expect(prism.astGenerator).toBeTruthy();
    expect(prism.isRegistered("python")).toBe(true);
    expect(prism.isRegistered("bash")).toBe(true);
  });
});
