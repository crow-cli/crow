import { Backend, type BackendOptions } from "../src/backend.js";
import { WebSocket } from "ws";

export async function waitFor(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A webview stand-in: numeric request ids, records every frame it sees. */
export class TestClient {
  readonly frames: any[] = [];
  readonly ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private closed = false;

  constructor(endpoint: string) {
    this.ws = new WebSocket(endpoint);
    this.ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      this.frames.push(msg);
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message) as Error & { code?: number };
          err.code = msg.error.code;
          p.reject(err);
        } else p.resolve(msg.result);
      }
    });
    this.ws.on("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("client closed"));
      this.pending.clear();
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  async request(method: string, params?: unknown): Promise<any> {
    await this.opened();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  get isClosed(): boolean {
    return this.closed;
  }
  close(): void {
    this.ws.close();
  }
}

export function makeBackend(opts: Partial<BackendOptions> & { external: string }): { backend: Backend; logs: string[]; start: () => Promise<string> } {
  const logs: string[] = [];
  const backend = new Backend({
    log: (l) => logs.push(l),
    cliCommand: ["true"],
    firstPort: 29000,
    ...opts,
  });
  return { backend, logs, start: () => backend.start() };
}
