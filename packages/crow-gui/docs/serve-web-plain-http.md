# Running Crow ACP Chat over plain HTTP (LAN, no TLS)

`crow serve-web` serves the VS Code workbench from a local server. Out of the box the
**Crow ACP chat webview is blank** when the workbench is opened from another machine over
plain HTTP (e.g. `http://192.168.1.175:8995`). This document explains every root cause and
the fix for each, so the chat works on an insecure LAN origin with **no certificate and no
SSH tunnel**.

All fixes are verified end-to-end with a real browser against `http://<lan-ip>:<port>`:
the chat UI renders, resources load `200`, and the webview opens a live ACP WebSocket to
the backend over the LAN.

---

## Background: how a VS Code web webview loads

A webview is two nested iframes:

1. **Shell** — `vs/workbench/contrib/webview/browser/pre/index.html`, served from the
   workbench origin. It bootstraps messaging and writes the extension's HTML into:
2. **Content** — an inner iframe loaded from `./fake.html` (same origin), then
   `document.write`-n with the extension HTML.

Extension resource URIs (`webview.asWebviewUri(...)`) are built as
`https://<scheme>+<encoded-authority>.vscode-resource.vscode-cdn.net/<path>`. That host is
**never meant to resolve** — a **service worker** intercepts those requests and fulfils
them by asking the workbench for the bytes (`load-resource` → `/vscode-remote-resource`).

Two browser platform rules break this on plain HTTP:

- **Service workers require a secure context.** On `http://<lan-ip>` `navigator.serviceWorker`
  is `undefined`, so nothing intercepts the `vscode-cdn.net` URLs.
- **`crypto.subtle` requires a secure context.** The shell's origin handshake
  (`parentOriginHash`) needs it.

These are browser limits, not VS Code hooks. The fixes below give the webview a
**no-service-worker path** that works on an insecure origin.

---

## Root causes & fixes

### 1. Self-hosted webview shell 403'd by the connection-token gate
**File:** `vscodium/patches/user/08-self-hosted-webview-serve.patch`
(`src/vs/server/node/remoteExtensionHostAgentServer.ts`)

Patch 07 serves the webview shell from our own origin (`/static/.../webview/browser/pre/`)
instead of the Microsoft CDN. But the server's token gate runs before static serving, and
the shell's module-worker fetch of `service-worker.js` omits the `vscode-tkn` cookie → `403`
→ "Could not register service worker" → blank chat **even on secure localhost**.

**Fix:** skip the gate only for the self-hosted webview shell path:
```ts
const isSelfHostedWebviewShell =
  pathname.startsWith('/static/') &&
  pathname.includes('/out/vs/workbench/contrib/webview/browser/pre/');
if (!isSelfHostedWebviewShell && !httpRequestHasValidConnectionToken(...)) { /* 403 */ }
```
All other routes stay gated.

### 2. `crypto.subtle` origin hash demanded for same-origin webviews
**File:** `08-self-hosted-webview-serve.patch`
(`src/vs/workbench/contrib/webview/browser/webviewElement.ts`, `mountTo`)

`mountTo` called `parentOriginHash(...)` (needs `crypto.subtle`) even for same-origin
webviews with no `{{uuid}}` subdomain. On an insecure origin that throws.

**Fix:** only hash for uuid-subdomain endpoints; otherwise use the window origin directly.
The placeholder **must be non-empty** — `_registerMessageHandler` bails on an empty
`_encodedWebviewOrigin`, which breaks the ready handshake:
```ts
const needsOriginHash = this._environmentService.webviewExternalEndpoint.includes('{{uuid}}');
this._encodedWebviewOriginPromise =
  (needsOriginHash ? parentOriginHash(targetWindow.origin, this.origin)
                   : Promise.resolve(targetWindow.origin))
  .then(id => this._encodedWebviewOrigin = id);
```
(Patch 07 also short-circuits the matching check in `pre/index.html` `signalReady` when
`parent.hostname === location.hostname`.)

### 3. No service worker on insecure origins → resources never load
**Files:** `vscodium/patches/user/09-insecure-origin-webviews.patch`

This is the core LAN fix. Three coordinated changes give the webview a direct-HTTP
resource path when no service worker is available:

**a. Auto no-SW mode** (`webviewElement.ts`, `_initElement`):
```ts
if (this._options.disableServiceWorker ||
    (typeof isSecureContext === 'boolean' && !isSecureContext)) {
  params.disableServiceWorker = 'true';
}
```
`pre/index.html` already honours `disableServiceWorker` (resolves `workerReady` immediately,
skips SW registration/messaging).

**b. Same-origin resource URLs** (`common/webview.ts`, `asWebviewUri`): when running in an
insecure browser context (workbench window or web-worker ext host), emit a path-preserving
same-origin URL instead of the un-interceptable CDN URL:
```ts
if (typeof isSecureContext === 'boolean' && !isSecureContext && typeof location !== 'undefined') {
  return URI.from({
    scheme: location.protocol === 'https:' ? Schemas.https : Schemas.http,
    authority: location.host,
    path: `/vscode-webview-resource/${resource.scheme}+${encodeAuthority(resource.authority)}${resource.path}`,
    fragment: resource.fragment, query: resource.query,
  });
}
```
In Node `isSecureContext` is `undefined`, so this branch is skipped (desktop/remote node
ext hosts keep the CDN form). Path structure is preserved so relative module imports and
CSS `url(...)` resolve correctly.

**c. HTML rewrite at the shell** (`pre/index.html`, `toContentHtml`): the crow-acp extension
runs in the **server's Node ext host** (`extensionKind: ["workspace"]`), which cannot know the
browser origin, so it still emits CDN URLs. The shell rewrites them where the HTML lands:
```js
if (disableServiceWorker) {
  // https://<auth>.vscode-resource.vscode-cdn.net/<path>
  //   -> <origin>/vscode-webview-resource/<auth>/<path>
  // applied to every attribute and <style> text; '*' excluded so CSP wildcards survive.
}
```

**d. Server route** (`remoteExtensionHostAgentServer.ts`): serve the path-based form. It is
authenticated by the same `vscode-tkn` cookie as `/vscode-remote-resource` (the content
iframe is same-origin, so the cookie is sent):
```ts
if (pathname === '/vscode-remote-resource' || pathname.startsWith('/vscode-webview-resource/')) {
  // /vscode-webview-resource/<scheme>+<encoded-authority>/<path>  -> serve <path>
}
```

### 4. The shell blocked *itself* — stale CSP script hash  ← the subtle one
**File:** `09-insecure-origin-webviews.patch` (`pre/index.html` CSP meta)

`pre/index.html` pins its own inline bootstrap `<script>` with a sha256 hash in its CSP meta:
```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'sha256-<HASH>' 'self'; frame-src 'self'; ...">
```
Adding fix 3c changed the script's bytes, so the hash no longer matched and the browser
refused to run **any** of the shell code → blank webview, console error
`Executing inline script violates ... script-src 'sha256-...'`.

**Fix:** recompute the hash over the exact text between `<script async type="module">` and
`</script>` (UTF-8, sha256, base64) and update the meta. Any future edit to that script must
refresh this hash. Current value: `sha256-wzIKuV49WQvk2/v8AOcjCox0QTBJLFjNWkj0seKclcM=`.

### 5. Backend proxy was loopback-only and unauthenticated
**Files:** `packages/vscode-acp/src/{backend,mcp,extension}.ts`, `packages/chat/src/vscode.tsx`

The chat webview talks to a per-window ACP/MCP proxy spawned by the extension. Two problems
on a LAN:

- The proxy listened on `127.0.0.1` **on the server**, and the webview dialled
  `ws://127.0.0.1:<port>` — which from another machine is the *client's* own loopback.
- Exposing it naively would leave an unauthenticated agent socket on the LAN.

**Fix:**
- `extension.ts`: when `vscode.env.uiKind === Web`, pass `listenHost: "0.0.0.0"`.
- `backend.ts`: when bound beyond loopback, require a per-window capability token
  (`?tkn=<uuid>`) on both the `/acp` WebSocket upgrade (`verifyClient`) and `/mcp`
  (`attachMcp(..., authorize)`). The token rides in `endpoint`/`mcpEndpoint`, which reach
  the webview only through the authenticated workbench. Loopback (desktop) is unchanged.
- `chat/vscode.tsx`: on an `http(s)` page, rewrite a loopback endpoint host to
  `location.hostname` (the server as the client sees it). Desktop webviews
  (`vscode-webview://` origin) keep loopback.

Result: `ws://<lan-ip>:<port>/acp?tkn=<uuid>` — reachable and authenticated.

### 6. Spawn mode crashed: "no free port" was a misleading label
**File:** `packages/vscode-acp/src/backend.ts` (`spawnDaemon`)

Spawn mode reported `no free port for the crow daemon in 2771..2834` even with free ports.
The real cause: the spawned `crow-cli` died instantly on every port with
```
crow_cli/cli/main.py: cwd: str = typer.Option(os.getcwd(), ...)
FileNotFoundError: [Errno 2] No such file or directory
```
`crow-cli` evaluates `os.getcwd()` at import; the extension host's inherited cwd can be a
**since-deleted directory**, so the child crashes before binding. The loop burned all 64
ports and mislabelled daemon crashes as port exhaustion.

**Fix:**
- Spawn with an explicit existing cwd: `spawn(cmd, argv, { ..., cwd: os.homedir() })`.
  (Session working directories are passed separately over ACP, so the startup cwd only
  needs to exist.)
- Track free ports tried; if any were free but the daemon never came up, report
  `crow daemon failed to start on any of N free port(s) ... see the daemon errors above`
  instead of "no free port".

---

## Patch inventory (applied in order to the VS Code checkout)

| Patch | Subject |
|-------|---------|
| 07 | Self-host the webview shell from our origin (endpoint + `signalReady` shortcut + CSP hash). |
| 08 | Token-gate exemption for the shell; skip `parentOriginHash` for same-origin webviews. |
| 09 | No-service-worker resource path on insecure origins (auto no-SW, same-origin URLs, shell HTML rewrite, server route) **and the refreshed CSP script hash**. |

Patches 07/08 were committed earlier (`0f7046c`); 09 is new. The extension/chat changes
(5, 6) live in `packages/vscode-acp` and `packages/chat` and are built into the package by
`build.sh`.

> **Build gotcha:** `pre/index.html` is a copied static asset. If you edit it *during* a
> build, the asset-copy step may have already run and the old file gets packaged. Edit it
> before building, or re-copy it into the `out*` trees and repackage. Always recompute the
> CSP script hash after editing its inline script.

---

## Verifying

1. Build: `packages/crow-gui/build.sh --deb` (bundles the extension + webview shell).
2. Run the web server tree on a LAN port:
   `vscode-reh-web-linux-x64/bin/crow-server --host 0.0.0.0 --port 8997 --connection-token <tok>`.
3. From another machine open `http://<lan-ip>:8997/?tkn=<tok>` with a **full browser**
   (Chromium/Brave/Firefox). Hard-refresh to avoid a cached shell.
4. Open a folder and **Trust** it — Workspace Trust Restricted Mode disables the
   workspace-kind chat extension entirely (a blank/missing chat on its own).
5. Open the Crow sidebar. Expect the composer, model picker, and a live
   `ws://<lan-ip>:<port>/acp?tkn=...` connection.

> **Test-harness gotcha:** Playwright's default `chromium_headless_shell` mis-reports
> `MessageEvent.source` for same-origin `postMessage`, which hangs the worker ext-host
> bootstrap and fakes a blank webview. Validate with full Chromium
> (`chromium-1255/chrome-linux64/chrome`), not the headless shell.

## Installing on the real server

The packaged server lives at `/usr/share/crow` (root-owned). Install the rebuilt package:
```
sudo dpkg -i packages/crow-gui/vscodium/assets/crow_1.135.07833_amd64.deb
```
then restart `crow serve-web`. (sudo is required; it is not available to the agent.)
