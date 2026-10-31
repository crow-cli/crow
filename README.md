# crow

The crow client: the terminal agent (`crow-agent`) and the IDE, built from a
vendored VS Code pipeline.

crow is a terminal-native front end for AI coding agents that speak the Agent
Client Protocol. This repository holds the *client* side; the agent itself
lives in [`crow-cli`](https://github.com/crow-cli/crow-cli) (Python) and is
talked to over ACP.

## Layout

| path | what it is |
| --- | --- |
| `crates/crow-client` | the agent TUI. `[[bin]] name = "crow-agent"` — the terminal crow lives in |
| `packages/crow-gui` | the IDE build pipeline: a vendored, rebranded copy of VSCodium's, producing the desktop app (`crow`) and the web server (`crow-server`) |
| `packages/vscode-acp` | the ACP chat extension, shipped as a built-in extension in every packaged tree |
| `packages/chat` | the chat webview (React + assistant-ui) the extension loads |
| `packages/aui` | the assistant-ui ACP packages (`@crow/aui-*`), vendored builds included |

## Building

The TUI is plain Rust:

```bash
cargo build --release --bin crow-agent
```

The IDE is not a cargo build — it fetches the pinned VS Code, applies ~45
patches, builds the workbench with gulp, compiles the Rust CLI, and packages
per platform. See [`packages/crow-gui/README.md`](packages/crow-gui/README.md):

```bash
cd packages/crow-gui
./build.sh --help
./build.sh --assets --deb --rpm        # linux x64, with release artifacts
```

Each platform is packaged **on** that platform. `.github/workflows/build-ide.yml`
does exactly that (linux x64/arm64, darwin x64/arm64, win32 x64) on demand, and
publishes the artifacts to a release for a `v*` tag.

## License

MIT — see [LICENSE.md](LICENSE.md). The vendored VS Code build pipeline carries
its own MIT license in `packages/crow-gui/vscodium/LICENSE`.
