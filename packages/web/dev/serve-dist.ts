/**
 * A static server for `packages/web/dist`, so the browser proofs run against
 * the *built* page and not against vite's dev server.
 *
 * Phase 26 replaces this with the real thing — crow-research's `serve_http`
 * mounting the same `dist` beside the `/acp` WebSocket, which is what makes the
 * page same-origin with its agent. Until then the proofs need something that
 * serves three files over http, and `vite preview` is a build tool doing a
 * web server's job slowly.
 *
 * Standalone:
 *
 *   bun dev/serve-dist.ts --port 2798 [--root ../web/dist]
 *
 * In-process (what `e2e/browser.test.ts` does):
 *
 *   const site = startDistServer({ port: 0 });
 *   ... site.url, site.stop()
 */

import { normalize, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export type DistServerOptions = {
  /** Directory to serve. Defaults to this package's `dist`. */
  root?: string;
  host?: string;
  /** 0 asks the OS for a free port; read it back off `server.port`. */
  port?: number;
  quiet?: boolean;
};

export type DistServer = {
  url: string;
  port: number;
  stop(): void;
};

export function startDistServer(options: DistServerOptions = {}): DistServer {
  const host = options.host ?? "127.0.0.1";
  const root = resolve(options.root ?? resolve(import.meta.dir, "..", "dist"));
  const quiet = options.quiet ?? false;

  const server = Bun.serve({
    hostname: host,
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const target = resolve(root, relative === "" ? "index.html" : normalize(relative));
      // `normalize` alone still lets `../../etc/passwd` out of the root.
      if (target !== root && !target.startsWith(root + sep)) {
        return new Response("forbidden", { status: 403 });
      }
      const file = Bun.file(target);
      if (!(await file.exists())) {
        return new Response(`not found: ${url.pathname}\n`, { status: 404 });
      }
      const extension = target.slice(target.lastIndexOf("."));
      if (!quiet) console.log("[serve-dist]", request.method, url.pathname, "->", target.slice(root.length + 1));
      return new Response(file, {
        headers: {
          "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
          // A proof that caches a stale bundle proves nothing.
          "cache-control": "no-store",
        },
      });
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("Bun.serve reported no port");
  return {
    url: `http://${host}:${port}/`,
    port,
    stop: () => server.stop(true),
  };
}

const argv = process.argv.slice(2);

function option(name: string, fallback: string): string {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

if (import.meta.main) {
  const server = startDistServer({
    host: option("host", "127.0.0.1"),
    port: Number(option("port", "2798")),
    root: option("root", resolve(import.meta.dir, "..", "dist")),
  });
  console.log(`serving ${resolve(import.meta.dir, "..", "dist")} at ${server.url}`);
}
