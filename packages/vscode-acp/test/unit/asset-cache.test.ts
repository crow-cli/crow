import { describe, test, expect, mock } from "bun:test";

/**
 * The webview service worker caches resources by URL. `chat.js`/`chat.css` keep
 * stable names across rebuilds, so a rebuilt bundle could be served stale to one
 * pane while another paints the new one (the "highlighted in the sidebar, plain
 * in the editor" split). The fix keys the asset URL on a content hash. The
 * regression this hunts: a cache key that does NOT change when the bundle bytes
 * change, which would let the service worker keep serving the old bundle.
 */
mock.module("vscode", () => ({
  ThemeIcon: class { constructor(public id: string) {} },
  QuickPickItemKind: { Separator: -1 },
}));

const { assetCacheKey } = await import("../../src/extension.js");

describe("webview asset cache-busting", () => {
  test("identical bytes yield a stable key (cache hits within a build)", () => {
    expect(assetCacheKey("bundle-bytes")).toBe(assetCacheKey("bundle-bytes"));
  });

  test("a rebuilt bundle gets a different key (no stale service-worker hit)", () => {
    const v1 = assetCacheKey("console.log('old bundle')");
    const v2 = assetCacheKey("console.log('new bundle with syntax highlighting')");
    expect(v1).not.toBe(v2);
  });

  test("a one-byte change still busts the cache", () => {
    expect(assetCacheKey("aaaa")).not.toBe(assetCacheKey("aaab"));
  });

  test("key is a short hex token safe for a ?v= query", () => {
    expect(assetCacheKey("x")).toMatch(/^[0-9a-f]{12}$/);
  });

  test("accepts raw bytes as well as strings", () => {
    const bytes = new TextEncoder().encode("same content");
    expect(assetCacheKey(bytes)).toBe(assetCacheKey("same content"));
  });
});
