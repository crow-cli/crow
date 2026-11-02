/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { parseMcpConfig } from "./mcp-config";
import {
  DEFAULT_SETTINGS,
  endpointOf,
  queryStringOf,
  readSettings,
  sameOriginEndpoint,
  saveSettings,
  type StorageLike,
  type WebSettings,
} from "./web-settings";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage: StorageLike & { keys(): string[] } = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    keys: () => [...map.keys()],
  };
  return storage;
}

const with_ = (over: Partial<WebSettings>): WebSettings => ({ ...DEFAULT_SETTINGS, ...over });

describe("readSettings", () => {
  it("falls all the way through to the defaults", () => {
    const { settings, warnings, error } = readSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toEqual([]);
    expect(error).toBeUndefined();
  });

  it("ranks injected over query over stored over default, per field", () => {
    const storage = memoryStorage({
      "crow-web.url": "ws://stored:1/acp",
      "crow-web.cwd": "/stored",
      "crow-web.protocol": "1",
    });
    const { settings } = readSettings({
      storage,
      search: "?url=ws://query:2/acp&cwd=/query",
      injected: JSON.stringify({ url: "ws://injected:3/acp" }),
    });
    expect(settings.url).toBe("ws://injected:3/acp");
    expect(settings.cwd).toBe("/query");
    expect(settings.protocol).toBe("1");
    expect(settings.mcpConfig).toBe(DEFAULT_SETTINGS.mcpConfig);
  });

  it("reads the extension's spelling of the injected blob", () => {
    const { settings } = readSettings({
      injected: JSON.stringify({
        host: "sidebar",
        endpoint: "ws://127.0.0.1:9999/acp",
        cwd: "/work",
        protocol: "auto",
        mcpConfig: "mcpServers:\n  x:\n    command: /bin/echo\n    args: [hi]\n",
      }),
    });
    expect(settings.url).toBe("ws://127.0.0.1:9999/acp");
    expect(settings.cwd).toBe("/work");
    expect(settings.protocol).toBe("auto");
    expect(parseMcpConfig(settings.mcpConfig).servers).toEqual([
      { name: "x", command: "/bin/echo", args: ["hi"], env: [] },
    ]);
  });

  it("accepts a search string with or without its question mark", () => {
    expect(readSettings({ search: "?cwd=/a" }).settings.cwd).toBe("/a");
    expect(readSettings({ search: "cwd=/a" }).settings.cwd).toBe("/a");
  });

  it("falls back on a protocol it does not know, and says so", () => {
    const { settings, warnings } = readSettings({ search: "?protocol=3" });
    expect(settings.protocol).toBe("2");
    expect(warnings.join("\n")).toContain('protocol "3" is not one of auto, 1, 2');
  });

  it("surfaces a bad MCP document instead of throwing", () => {
    const { settings } = readSettings({ search: `?mcp=${encodeURIComponent("mcpServers: [")}` });
    const parsed = parseMcpConfig(settings.mcpConfig);
    expect(parsed.servers).toEqual([]);
    expect(parsed.error).toBeTruthy();
  });

  it("parses the board flag, and warns on a word that is not one", () => {
    expect(readSettings({ search: "?board=0" }).settings.board).toBe(false);
    expect(readSettings({ search: "?board=on" }).settings.board).toBe(true);
    const { settings, warnings } = readSettings({ search: "?board=maybe" });
    expect(settings.board).toBe(true);
    expect(warnings.join("\n")).toContain('board "maybe" is not a boolean');
  });

  it("reports an injected blob that is not JSON and resolves the rest anyway", () => {
    const { settings, warnings } = readSettings({ injected: "{not json", search: "?cwd=/still" });
    expect(settings.cwd).toBe("/still");
    expect(warnings.join("\n")).toContain("is not JSON");
  });

  it("refuses an endpoint that is not a WebSocket URL", () => {
    const { settings, error } = readSettings({ search: "?url=http://127.0.0.1:2771/acp" });
    expect(settings.url).toBe("http://127.0.0.1:2771/acp");
    expect(error).toContain("is not a ws:// or wss:// URL");
  });
});

describe("same-origin endpoints", () => {
  it("turns the serving origin into the agent's ws endpoint", () => {
    expect(sameOriginEndpoint("http://127.0.0.1:2771")).toBe("ws://127.0.0.1:2771/acp");
    expect(sameOriginEndpoint("https://crow.example")).toBe("wss://crow.example/acp");
    expect(sameOriginEndpoint("file:///tmp/index.html")).toBeUndefined();
    expect(sameOriginEndpoint("nonsense")).toBeUndefined();
  });

  it("resolves an empty url to whoever served the page", () => {
    const settings = with_({ url: "" });
    expect(endpointOf(settings, "http://127.0.0.1:2771")).toBe("ws://127.0.0.1:2771/acp");
    expect(endpointOf(settings)).toBe(DEFAULT_SETTINGS.url);
    expect(endpointOf(with_({ url: "ws://elsewhere:1/acp" }), "http://127.0.0.1:2771")).toBe(
      "ws://elsewhere:1/acp",
    );
  });

  it("lets an empty url arrive through the query and through storage", () => {
    expect(readSettings({ search: "?url=", origin: "http://h:1" }).settings.url).toBe("");
    expect(readSettings({ storage: memoryStorage({ "crow-web.url": "" }) }).settings.url).toBe("");
  });
});

describe("saveSettings", () => {
  it("stores only what differs from the defaults", () => {
    const storage = memoryStorage();
    saveSettings(storage, with_({ cwd: "/work", board: false }));
    expect(storage.keys().sort()).toEqual(["crow-web.board", "crow-web.cwd"]);
    expect(storage.getItem("crow-web.cwd")).toBe("/work");
    expect(storage.getItem("crow-web.board")).toBe("false");
    const { settings } = readSettings({ storage });
    expect(settings.cwd).toBe("/work");
    expect(settings.board).toBe(false);
    expect(settings.url).toBe(DEFAULT_SETTINGS.url);
  });

  it("removes a stored value that went back to the default", () => {
    const storage = memoryStorage({ "crow-web.cwd": "/work" });
    saveSettings(storage, DEFAULT_SETTINGS);
    expect(storage.keys()).toEqual([]);
    expect(readSettings({ storage }).settings.cwd).toBe("");
  });

  it("does nothing without storage", () => {
    expect(() => saveSettings(null, DEFAULT_SETTINGS)).not.toThrow();
  });
});

describe("queryStringOf", () => {
  it("carries only the differences, and round-trips", () => {
    const settings = with_({ cwd: "/work", protocol: "1", board: false });
    const query = queryStringOf(settings);
    expect(query).toContain("cwd=%2Fwork");
    expect(query).toContain("protocol=1");
    expect(query).toContain("board=false");
    expect(query).not.toContain("url=");
    expect(readSettings({ search: query }).settings).toEqual(settings);
  });

  it("is empty for the defaults", () => {
    expect(queryStringOf(DEFAULT_SETTINGS)).toBe("");
  });
});
