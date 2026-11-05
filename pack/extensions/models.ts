/**
 * NusaGate model list for `/model`, from the gateway's public catalog.
 *
 * Startup model selection runs before any network call could finish, and a saved
 * default such as `kimi-k3` must resolve then. So the list is registered from a
 * cache file while this extension loads, and refreshed from the catalog that
 * meter.ts fetches each session. With no cache yet, models.json is the fallback.
 *
 * The catalog has no capability fields, so every model gets the same limits as
 * the models.json entry: text input, 16384 output tokens. DeepSeek models are the
 * ones verified to answer with `reasoning_content` and accept the gateway's
 * `thinking` / `reasoning_effort` parameters, so they alone are registered as
 * reasoning models. Rupiah costs stay in meter.ts, so pi's dollar cost stays zero.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CATALOG_CHANNEL } from "./meter.ts";
import { agentDir } from "../lib/home.ts";

const PROVIDER = "nusagate";
const BASE_URL = "https://api.nusagate.com/v1";
const CACHE_FILE = "nusagate-models.json";
const MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Reasoning models on the gateway: they take `thinking` and return `reasoning_content`. */
const REASONING = /^deepseek-/;
/** Models known to accept image input. The catalog does not say, so this is an explicit list. */
const VISION = /^deepseek-v4.1-flash$/;

export type CatalogModel = { id: string; name: string; contextWindow: number };

/** The usable rows of a catalog response; rows without an id are dropped. */
export function parseCatalog(rows: unknown): CatalogModel[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const entry = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
    if (typeof entry.id !== "string" || !entry.id) return [];
    const name = typeof entry.displayName === "string" && entry.displayName ? entry.displayName : entry.id;
    const context = entry.contextLength;
    const contextWindow = typeof context === "number" && context > 0 ? context : DEFAULT_CONTEXT_WINDOW;
    return [{ id: entry.id, name, contextWindow }];
  });
}

function homeDir(): string {
  return agentDir();
}

function readCache(dir: string): CatalogModel[] {
  try {
    return parseCatalog(JSON.parse(readFileSync(join(dir, CACHE_FILE), "utf8")).models);
  } catch {
    return []; // No cache yet, or an unreadable one: models.json still applies.
  }
}

function writeCache(dir: string, models: CatalogModel[]): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, CACHE_FILE);
  const temp = `${target}.tmp`;
  const rows = models.map(({ id, name, contextWindow }) => ({ id, displayName: name, contextLength: contextWindow }));
  writeFileSync(temp, `${JSON.stringify({ models: rows }, null, 2)}\n`);
  renameSync(temp, target);
}

function register(pi: ExtensionAPI, models: CatalogModel[]): void {
  pi.registerProvider(PROVIDER, {
    name: "NusaGate",
    baseUrl: BASE_URL,
    apiKey: "$NUSAGATE_API_KEY",
    api: "openai-completions",
    models: models.map(({ id, name, contextWindow }) => ({
      id,
      name,
      ...(REASONING.test(id)
        ? { reasoning: true, compat: { thinkingFormat: "deepseek" as const, supportsReasoningEffort: true } }
        : { reasoning: false }),
      input: VISION.test(id) ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: MAX_OUTPUT_TOKENS,
    })),
  });
}

export default function models(pi: ExtensionAPI) {
  let current = readCache(homeDir());
  if (current.length > 0) register(pi, current);

  pi.events.on(CATALOG_CHANNEL, (rows) => {
    const fresh = parseCatalog(rows);
    // An empty or unchanged catalog must not disturb the session's current model.
    if (fresh.length === 0 || JSON.stringify(fresh) === JSON.stringify(current)) return;
    current = fresh;
    register(pi, fresh);
    try {
      writeCache(homeDir(), fresh);
    } catch {
      // The list still works this session; the next one fetches it again.
    }
  });
}
