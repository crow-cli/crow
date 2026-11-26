import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffViewer } from "@/components/ui/diff-viewer";
import { highlightLine, languageFromPath } from "@/lib/syntax-highlighter";

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
