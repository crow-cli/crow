import { describe, test, expect } from "bun:test";
import { makeBackend } from "../helpers.js";
import { resolveServerEntry } from "../../src/backend.js";

/**
 * crowAcp.server is the paste-able server entry, MCP-server style: one JSON
 * object instead of eight scattered settings. The regression this hunts: an
 * entry that silently fails to override (the user pastes a source-checkout
 * command and gets the installed crow-cli anyway), or a malformed entry that
 * spawns the wrong daemon instead of reporting the mistake.
 */
describe("resolveServerEntry", () => {
  test("absent or empty entry keeps the legacy settings", () => {
    expect(resolveServerEntry(undefined)).toEqual({});
    expect(resolveServerEntry(null)).toEqual({});
    expect(resolveServerEntry({})).toEqual({});
  });

  test("a full spawn entry maps every field", () => {
    expect(
      resolveServerEntry({
        command: "uv",
        args: ["--project", "/src/crow-cli", "run", "crow-cli"],
        model: "claude-sonnet-4-5",
        port: 2800,
        cwd: "/work",
        mcpServers: { "crow-mcp": { transport: "stdio", command: "crow-cli", args: ["mcp2"] } },
      }),
    ).toEqual({
      cliCommand: ["uv", "--project", "/src/crow-cli", "run", "crow-cli"],
      extraArgs: ["--model", "claude-sonnet-4-5"],
      firstPort: 2800,
      cwd: "/work",
      mcpConfig: JSON.stringify({ "crow-mcp": { transport: "stdio", command: "crow-cli", args: ["mcp2"] } }),
    });
  });

  test("endpoint selects external, whatever else is present", () => {
    expect(resolveServerEntry({ endpoint: "ws://127.0.0.1:2771/acp" })).toEqual({
      external: "ws://127.0.0.1:2771/acp",
    });
    expect(
      resolveServerEntry({ endpoint: "ws://host:2771/acp", command: "crow-cli" }),
    ).toEqual({ external: "ws://host:2771/acp" });
  });

  test("a partial entry overrides only its own fields", () => {
    expect(resolveServerEntry({ port: 2900 })).toEqual({ firstPort: 2900 });
    expect(resolveServerEntry({ command: "crow-cli" })).toEqual({ cliCommand: ["crow-cli"] });
    expect(resolveServerEntry({ model: "" })).toEqual({});
    expect(resolveServerEntry({ cwd: "" })).toEqual({});
  });

  test("malformed entries report a config error instead of guessing", () => {
    expect(resolveServerEntry("ws://x").configError).toContain("JSON object");
    expect(resolveServerEntry([]).configError).toContain("JSON object");
    expect(resolveServerEntry({ endpoint: 42 }).configError).toContain("endpoint");
    expect(resolveServerEntry({ endpoint: "" }).configError).toContain("endpoint");
    expect(resolveServerEntry({ command: "" }).configError).toContain("command");
    expect(resolveServerEntry({ command: ["crow-cli"] }).configError).toContain("command");
    expect(resolveServerEntry({ command: "uv", args: "run" }).configError).toContain("args");
    expect(resolveServerEntry({ command: "uv", args: [1] }).configError).toContain("args");
    expect(resolveServerEntry({ args: ["run"] }).configError).toContain("command");
    expect(resolveServerEntry({ model: 7 }).configError).toContain("model");
    expect(resolveServerEntry({ port: "2771" }).configError).toContain("port");
    expect(resolveServerEntry({ port: 0 }).configError).toContain("port");
    expect(resolveServerEntry({ port: 70000 }).configError).toContain("port");
    expect(resolveServerEntry({ port: 2771.5 }).configError).toContain("port");
    expect(resolveServerEntry({ cwd: 3 }).configError).toContain("cwd");
    expect(resolveServerEntry({ mcpServers: [] }).configError).toContain("mcpServers");
    expect(resolveServerEntry({ mcpServers: "x" }).configError).toContain("mcpServers");
  });
});

describe("backend start with a malformed entry", () => {
  test("fails with the config error instead of spawning", async () => {
    const { backend, start } = makeBackend({
      external: "ws://127.0.0.1:1/acp",
      configError: "crowAcp.server: port must be an integer in 1..65535",
    });
    try {
      await expect(start()).rejects.toThrow("port must be an integer");
    } finally {
      backend.dispose();
    }
  });
});
