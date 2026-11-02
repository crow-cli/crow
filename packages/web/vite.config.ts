import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const chat = path.resolve(import.meta.dirname, "../chat");

/**
 * The browser host's build: the same shape as `packages/vscode-acp/vite.config.ts`
 * — root is the chat package, the entry lives in `chat/src` — with the one
 * difference that follows from having no native half. The extension injects its
 * HTML as a string, so it pins `chat.js`/`chat.css` and names its input
 * explicitly; a browser loads a checked-in `chat/index.html`, so vite owns the
 * asset names and `dev` and `build` share one entry. The output is this
 * package's own `dist`, which is what the agent serves beside `/acp`.
 */
export default defineConfig({
  root: chat,
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.join(chat, "src") },
    dedupe: ["react", "react-dom", "@assistant-ui/react", "@assistant-ui/core"],
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
  },
});
