"use client";

import { Fragment, type FC, type ReactNode } from "react";
// Type-only bare import: loads @types' ambient declarations for the deep
// ESM paths below (the package itself ships no per-file .d.ts).
import type {} from "react-syntax-highlighter";
import PrismAsyncLight from "react-syntax-highlighter/dist/esm/prism-async-light";
import { refractor } from "refractor/core";
import rust from "refractor/rust";
import css from "refractor/css";
import markup from "refractor/markup";
import markdown from "refractor/markdown";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";

import { cn } from "@/lib/utils";

PrismAsyncLight.registerLanguage("python", python);
PrismAsyncLight.registerLanguage("bash", bash);
PrismAsyncLight.registerLanguage("sh", bash);
PrismAsyncLight.registerLanguage("shell", bash);
PrismAsyncLight.registerLanguage("json", json);
PrismAsyncLight.registerLanguage("typescript", typescript);
PrismAsyncLight.registerLanguage("ts", typescript);
PrismAsyncLight.registerLanguage("tsx", tsx);
PrismAsyncLight.registerLanguage("jsx", jsx);
PrismAsyncLight.registerLanguage("javascript", javascript);
PrismAsyncLight.registerLanguage("js", javascript);
PrismAsyncLight.registerLanguage("yaml", yaml);
PrismAsyncLight.registerLanguage("diff", diff);
PrismAsyncLight.registerLanguage("toml", toml);
PrismAsyncLight.registerLanguage("sql", sql);

// Kick the Prism core load at module evaluation, not at the first fence's
// componentDidMount. A restored session (session/load) paints its whole
// transcript in one commit; a cold highlighter would otherwise render every
// fence plain on that first paint and only colorize a tick later when the
// async generator resolves. Preloading means the generator is ready before
// React mounts, so restored and streaming fences highlight identically.
(PrismAsyncLight as unknown as { preload(): Promise<void> }).preload();

// A second, synchronous refractor instance for per-line diff highlighting.
// The language modules above are refractor syntax functions, so the same
// grammars serve both the async markdown fences and the diff lines.
for (const syntax of [bash, json, javascript, jsx, python, sql, toml, tsx, typescript, yaml, rust, css, markup, markdown]) {
  refractor.register(syntax);
}

const EXT_LANGUAGE: Record<string, string> = {
  py: "python", pyi: "python",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  rs: "rust", json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
  css: "css", html: "markup", xml: "markup", svg: "markup",
  md: "markdown",
};

/** The highlighter language for a file path, from its extension. */
export function languageFromPath(path: string | undefined): string | undefined {
  const ext = path?.split(".").pop()?.toLowerCase();
  return ext ? EXT_LANGUAGE[ext] : undefined;
}

// Token colours ride the theme's CSS variables, so light/dark/macchiato
// each get their own palette without a second highlighter tree.
const token = (color: string, extra?: Record<string, string>) => ({
  color,
  ...extra,
});

const CODE_THEME: Record<string, Record<string, string>> = {
  comment: token("var(--code-comment)", { fontStyle: "italic" }),
  prolog: token("var(--code-comment)"),
  doctype: token("var(--code-comment)"),
  cdata: token("var(--code-comment)"),
  punctuation: token("var(--code-punctuation)"),
  property: token("var(--code-property)"),
  tag: token("var(--code-type)"),
  symbol: token("var(--code-type)"),
  string: token("var(--code-string)"),
  char: token("var(--code-string)"),
  "attr-value": token("var(--code-string)"),
  regex: token("var(--code-string)"),
  boolean: token("var(--code-number)"),
  number: token("var(--code-number)"),
  constant: token("var(--code-number)"),
  operator: token("var(--code-operator)"),
  entity: token("var(--code-operator)"),
  url: token("var(--code-operator)"),
  function: token("var(--code-function)"),
  builtin: token("var(--code-function)"),
  "class-name": token("var(--code-type)"),
  classname: token("var(--code-type)"),
  "attr-name": token("var(--code-attr)"),
  variable: token("var(--code-property)"),
  keyword: token("var(--code-keyword)"),
  inserted: token("var(--code-inserted)"),
  deleted: token("var(--code-deleted)"),
};

/** The markdown code-fence slot: renders inside the app's Pre/Code. */
export const CodeHighlighter: FC<SyntaxHighlighterProps> = ({
  components: { Pre, Code },
  language,
  code,
}) => (
  <PrismAsyncLight
    PreTag={Pre}
    CodeTag={Code}
    style={CODE_THEME}
    customStyle={{ background: "transparent", margin: 0, padding: 0 }}
    useInlineStyles
    language={language}
  >
    {code}
  </PrismAsyncLight>
);

const ToolPre: FC<React.ComponentProps<"pre">> = ({ className, ...props }) => (
  <pre
    className={cn(
      "text-foreground/90 overflow-x-auto px-3 py-2 whitespace-pre",
      className,
    )}
    {...props}
  />
);

const ToolCode: FC<React.ComponentProps<"code">> = (props) => (
  <code {...props} />
);

/**
 * Highlighted source inside a tool card (an `execute` cell, a fetched
 * snippet): same tokens as the markdown fences, terminal styling.
 */
export const ToolCodeBlock: FC<{
  code: string;
  language?: string;
  className?: string;
  "data-slot"?: string;
}> = ({ code, language = "python", className, ...rest }) => (
  <div className={className} {...rest}>
    <CodeHighlighter
      components={{ Pre: ToolPre, Code: ToolCode }}
      language={language}
      code={code}
    />
  </div>
);

type HastNode = {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
};

const tokenStyle = (className: string[] | undefined) => {
  let style: Record<string, string> | undefined;
  for (const cls of className ?? []) {
    const t = CODE_THEME[cls];
    if (t) style = { ...style, ...t };
  }
  return style;
};

const renderHast = (nodes: HastNode[]): ReactNode =>
  nodes.map((node, i) => {
    if (node.type === "text") return node.value;
    const children = renderHast(node.children ?? []);
    const style = tokenStyle(node.properties?.className);
    return style ? (
      <span key={i} style={style}>{children}</span>
    ) : (
      <Fragment key={i}>{children}</Fragment>
    );
  });

/**
 * One diff line, tokenized synchronously with the same palette as the
 * markdown fences. Untokenized text keeps the surrounding add/del color;
 * an unknown language or extension renders the line plain.
 */
export function highlightLine(code: string, language: string | undefined): ReactNode {
  if (!language || !refractor.registered(language)) return code;
  const tree = refractor.highlight(code, language) as unknown as HastNode;
  return renderHast(tree.children ?? []);
}
