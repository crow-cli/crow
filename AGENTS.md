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
- HARD browser limit (NOT fixable in crow): service workers require a secure context.
  Over plain http on a LAN IP / 0.0.0.0, `navigator.serviceWorker` is undefined and
  webviews throw "Service Workers are not enabled". Use HTTPS or localhost (SSH tunnel).
  localhost IS a secure context even over http.

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
