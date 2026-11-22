store user patches at location patches/user and those will be applied to vscode source git by the scripts

07/08/09 make the Crow ACP chat webview work over plain HTTP (LAN, no TLS):
self-hosted shell + token-gate exemption + no-service-worker resource path.
See packages/crow-gui/docs/serve-web-plain-http.md. After editing pre/index.html's
inline script, refresh its CSP sha256 (patch 09 carries the current hash).
