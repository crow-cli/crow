import { DEFAULT_MCP_CONFIG } from "@/lib/mcp-config";

/**
 * Where a browser host gets its settings.
 *
 * The extension's HTML carries them: a JSON blob in `<script
 * id="crow-acp-settings">` that `vscode.tsx` reads at module scope. A page
 * served off a dev server or a static directory has no host to inject anything,
 * so the same values arrive in the URL query and are remembered in localStorage
 * — and when the agent serves the page itself it injects the blob exactly like
 * the extension does, which is why the blob outranks both.
 *
 * Precedence, per field: injected blob > query > stored > `DEFAULT_SETTINGS`.
 *
 * Nothing here touches the DOM except through its arguments, so the whole
 * resolution is testable without a browser: `search`, `storage` and `origin`
 * are data, not globals.
 */

export const PROTOCOLS = ["auto", "1", "2"] as const;
export type WebProtocol = (typeof PROTOCOLS)[number];

export type WebSettings = {
  /** The agent's ACP WebSocket endpoint. Empty means "whoever served this page". */
  readonly url: string;
  /** The agent's working directory. Empty leaves the agent its own default. */
  readonly cwd: string;
  readonly protocol: WebProtocol;
  /** The tool supply, as YAML or JSON — `parseMcpConfig` reads it. */
  readonly mcpConfig: string;
  /** The conductor's endpoint, for the loop that keeps prompting this session. */
  readonly conductorUrl: string;
  /** Whether the board is shown beside the thread. */
  readonly board: boolean;
};

export const DEFAULT_SETTINGS: WebSettings = {
  url: "ws://127.0.0.1:2771/acp",
  cwd: "",
  protocol: "2",
  mcpConfig: DEFAULT_MCP_CONFIG,
  conductorUrl: "ws://127.0.0.1:2785/acp",
  board: true,
};

/** Query parameter and storage-key suffix per field. One table, both spellings. */
const KEYS = {
  url: "url",
  cwd: "cwd",
  protocol: "protocol",
  mcpConfig: "mcp",
  conductorUrl: "conductor",
  board: "board",
} as const satisfies Record<keyof WebSettings, string>;

const FIELDS = Object.keys(KEYS) as (keyof WebSettings)[];

const STORAGE_PREFIX = "crow-web.";

/** Fields where an empty string is an answer rather than an absence: an empty
 *  `url` means "the agent that served this page" and an empty `cwd` means "the
 *  agent's own default". Everywhere else, empty means "keep looking". */
const EMPTY_IS_ANSWER: ReadonlySet<string> = new Set(["url", "cwd"]);

/** The blob id the extension already uses, so one injector serves both hosts. */
export const SETTINGS_SCRIPT_ID = "crow-acp-settings";

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type SettingsInput = {
  /** `location.search`, with or without its leading `?`. */
  search?: string;
  /** `localStorage`. Absent means nothing is remembered and nothing is saved. */
  storage?: StorageLike | null;
  /** The text of the injected settings blob, when a host put one in the page. */
  injected?: string | null;
  /** `location.origin`, used to resolve an empty `url` to the serving agent. */
  origin?: string;
};

export type ResolvedSettings = {
  settings: WebSettings;
  /** The first thing that was wrong. The settings are still usable. */
  error?: string;
  /** Every field that fell back, and why — the settings sheet shows these. */
  warnings: string[];
};

/** The agent's own endpoint when the agent is also the web server: same host,
 *  same port, `/acp`. `origin` is a parameter so this needs no browser. */
export function sameOriginEndpoint(origin: string, path = "/acp"): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const scheme = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${parsed.host}${path}`;
}

function asProtocol(raw: string): WebProtocol | undefined {
  const value = raw.trim().toLowerCase();
  return (PROTOCOLS as readonly string[]).includes(value) ? (value as WebProtocol) : undefined;
}

function asBoolean(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return undefined;
}

function isEndpoint(raw: string): boolean {
  return raw.startsWith("ws://") || raw.startsWith("wss://");
}

/** The injected blob, in either host's spelling: the extension says `endpoint`
 *  and `mcpConfig`, the query says `url` and `mcp`. Both are read. */
function fromInjected(text: string, warnings: string[]): Partial<Record<keyof WebSettings, string>> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    warnings.push(`the injected ${SETTINGS_SCRIPT_ID} blob is not JSON (${(error as Error).message}) — ignored`);
    return {};
  }
  if (typeof doc !== "object" || doc === null) {
    warnings.push("the injected settings blob is not an object — ignored");
    return {};
  }
  const raw = doc as Record<string, unknown>;
  const out: Record<string, string> = {};
  const take = (key: string, ...names: string[]) => {
    for (const name of names) {
      const value = raw[name];
      if (typeof value === "string") return void (out[key] = value);
      if (typeof value === "boolean" || typeof value === "number") return void (out[key] = String(value));
    }
  };
  take("url", "url", "endpoint");
  take("cwd", "cwd");
  take("protocol", "protocol");
  take("mcpConfig", "mcpConfig", "mcp");
  take("conductorUrl", "conductorUrl", "conductor", "conductorEndpoint");
  take("board", "board");
  return out;
}

/** Resolve the settings a browser host should run with. */
export function readSettings(input: SettingsInput = {}): ResolvedSettings {
  const warnings: string[] = [];
  const query = new URLSearchParams(input.search?.replace(/^\?/, "") ?? "");
  const injected = typeof input.injected === "string" && input.injected.trim() ? fromInjected(input.injected, warnings) : {};
  const layers: ((field: keyof WebSettings) => string | undefined)[] = [
    (field) => injected[field],
    (field) => {
      const value = query.get(KEYS[field]);
      return value === null ? undefined : value;
    },
    (field) => input.storage?.getItem(STORAGE_PREFIX + KEYS[field]) ?? undefined,
  ];

  const resolved = {} as Record<keyof WebSettings, string>;
  for (const field of FIELDS) {
    let value: string | undefined;
    for (const layer of layers) {
      const candidate = layer(field);
      if (candidate !== undefined && candidate !== "") {
        value = candidate;
        break;
      }
      if (candidate === "" && EMPTY_IS_ANSWER.has(field)) {
        value = "";
        break;
      }
    }
    resolved[field] = value ?? String(DEFAULT_SETTINGS[field]);
  }

  const rawProtocol = resolved.protocol.trim();
  const protocol = rawProtocol ? asProtocol(rawProtocol) : DEFAULT_SETTINGS.protocol;
  if (rawProtocol && protocol === undefined) {
    warnings.push(`protocol ${JSON.stringify(rawProtocol)} is not one of ${PROTOCOLS.join(", ")} — using ${DEFAULT_SETTINGS.protocol}`);
  }

  const rawBoard = resolved.board.trim();
  const board = rawBoard ? asBoolean(rawBoard) : DEFAULT_SETTINGS.board;
  if (rawBoard && board === undefined) {
    warnings.push(`board ${JSON.stringify(rawBoard)} is not a boolean — using ${DEFAULT_SETTINGS.board}`);
  }

  const settings: WebSettings = {
    url: resolved.url.trim(),
    cwd: resolved.cwd.trim(),
    protocol: protocol ?? DEFAULT_SETTINGS.protocol,
    mcpConfig: resolved.mcpConfig,
    conductorUrl: resolved.conductorUrl.trim(),
    board: board ?? DEFAULT_SETTINGS.board,
  };

  let error: string | undefined;
  if (settings.url && !isEndpoint(settings.url)) {
    error = `the endpoint ${JSON.stringify(settings.url)} is not a ws:// or wss:// URL`;
    warnings.push(`${error} — the agent will not be reachable until it is fixed`);
  }

  return { settings, error, warnings };
}

/** The endpoint to connect to: the setting, or the serving agent when it is empty. */
export function endpointOf(settings: WebSettings, origin?: string): string {
  if (settings.url) return settings.url;
  return (origin && sameOriginEndpoint(origin)) ?? DEFAULT_SETTINGS.url;
}

/** Remember only what differs from the defaults, so a cleared field really
 *  clears and a stored value never outlives the default it repeats. */
export function saveSettings(storage: StorageLike | null | undefined, next: WebSettings): void {
  if (!storage) return;
  for (const field of FIELDS) {
    const key = STORAGE_PREFIX + KEYS[field];
    const value = String(next[field]);
    if (value === String(DEFAULT_SETTINGS[field])) storage.removeItem(key);
    else storage.setItem(key, value);
  }
}

/** A shareable query string: only the fields that differ from the defaults. */
export function queryStringOf(settings: WebSettings): string {
  const query = new URLSearchParams();
  for (const field of FIELDS) {
    const value = String(settings[field]);
    if (value !== String(DEFAULT_SETTINGS[field])) query.set(KEYS[field], value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}
