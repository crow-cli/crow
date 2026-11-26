# Crow clients repo — agent memory

## serve-web webview architecture (debugged 2026-11, session robust-mouse-of-total-temperance)
- `crow serve-web` serves the workbench AND self-hosted webviews from the same origin
  (vscodium patch `07-self-hosted-webview.patch`: `webClientServer.ts` sets
  `webviewEndpoint = staticRoute + '/out/vs/workbench/contrib/webview/browser/pre'`).
  Upstream VS Code serves webviews from the public `{{uuid}}.vscode-cdn.net` CDN instead.
- Two consequences of self-hosting, fixed in `08-self-hosted-webview-serve.patch`:
  1. The server connection-token gate (`remoteExtensionHostAgentServer.ts`,
     `httpRequestHasValidConnectionToken`) 403s the webview `service-worker.js`:
     module-worker script fetches omit the `vscode-tkn` cookie. Fix: exempt
     `/static/.../webview/browser/pre/` (public static shell, like the upstream CDN).
     Everything else (workbench.js, /vscode-remote-resource) stays gated.
  2. `webviewElement.ts mountTo` called `parentOriginHash` (needs `crypto.subtle`,
     i.e. secure context) even for same-origin webviews that have no `{{uuid}}`.
     Fix: only hash when the endpoint contains `{{uuid}}`; otherwise use
     `targetWindow.origin` as the encoded origin. NOTE: the placeholder MUST be
     non-empty — `_registerMessageHandler` bails on `!this._encodedWebviewOrigin`.
- Service workers need a secure context, so over plain http LAN `navigator.serviceWorker`
  is undefined. This IS worked around (no HTTPS/tunnel needed) by
  `09-insecure-origin-webviews.patch`: auto `disableServiceWorker` when `!isSecureContext`,
  `asWebviewUri` emits same-origin `/vscode-webview-resource/<scheme>+<auth>/<path>` URLs,
  `pre/index.html toContentHtml` rewrites CDN URLs to that route (covers the Node ext host,
  which can't know the browser origin), and the server serves the route (cookie-gated).
  Full write-up: `packages/crow-gui/docs/serve-web-plain-http.md`.
- CSP SCRIPT HASH GOTCHA: `pre/index.html` pins its inline bootstrap `<script>` with a
  sha256 in its own CSP meta (`script-src 'sha256-...'`). ANY edit to that script changes
  its bytes → hash mismatch → browser blocks the WHOLE shell → blank webview (console:
  "Executing inline script violates ... script-src"). Recompute sha256(base64) over the
  exact text between `<script async type="module">` and `</script>` and update the meta.
  Patch 07 and 09 both refresh it. Current: wzIKuV49WQvk2/v8AOcjCox0QTBJLFjNWkj0seKclcM=.
- pre/index.html is a COPIED static asset: editing it mid-build can miss the asset-copy
  step (old file gets packaged). Edit before building, or re-copy into the out* trees.
- LAN backend proxy (vscode-acp): the per-window ACP/MCP proxy must bind 0.0.0.0 in Web
  (`extension.ts` uiKind) and is token-gated (`?tkn=<uuid>`, backend.ts verifyClient +
  mcp.ts authorize). chat/vscode.tsx rewrites a loopback endpoint host to location.hostname
  on http(s) pages. Desktop (vscode-webview:// origin) keeps loopback, ungated.
- SPAWN MODE: crow-cli evaluates os.getcwd() at import; the ext host's inherited cwd can be
  a deleted dir → daemon crashes instantly → loop mislabels it "no free port". Fix:
  backend.ts spawnDaemon passes `cwd: os.homedir()` and reports daemon-failure accurately.
- Workspace Trust: Restricted Mode disables the workspace-kind crow-acp extension entirely
  (blank/missing chat). A folder must be Trusted; trust is per-browser (client-side) in web.

## Tooling gotcha — chrome-headless-shell lies about postMessage
- Playwright's default `chromium_headless_shell` (old headless) reports
  `MessageEvent.source` as the RECEIVING window for same-origin postMessage, not the
  sender. This breaks the VS Code web worker-ext-host bootstrap
  (`f.source !== s.contentWindow` check) and makes EVERY `activateByEvent` hang
  (renderer does Promise.all over remote+worker ext hosts). Symptom: blank webviews,
  "Web Worker Extension Host did not start in 60s".
- It is a headless-shell artifact, NOT a crow bug. Full Chromium
  (`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`, new headless) behaves
  correctly. ALWAYS validate webview/iframe messaging with full Chromium, not the
  headless shell. Launch via `pw.chromium.launch(executable_path=...chrome-linux64/chrome)`.

## Build / install
- `packages/crow-gui/build.sh --deb` builds desktop + reh-web + .deb from the vendored
  `vscodium/vscode` checkout. Patches live in `vscodium/patches/user/NN-*.patch` and are
  applied IN PLACE by `prepare_vscode.sh`; build.sh skips re-prepare when
  `vscode/.crow-prepared` matches the release (so live source edits are picked up on
  rebuild, but ALSO update the patch file for fresh prepares).
- `crow-cli install crow` builds from this checkout, installs the deb to /usr/share/crow
  (+ web/), launcher ~/.local/bin/crow. It skips building if a deb exists unless --rebuild.
- serve-web/exthost logs: ~/.local/state/Crow/<TS>/exthost1/ (remoteexthost.log,
  output_logging_*/1-Crow ACP.log), NOT ~/.crow-server/data/logs.
