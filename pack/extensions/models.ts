/**
 * NusaGate model list for `/model`, from the gateway's public catalog.
 *
 * Startup model selection runs before any network call could finish, and a saved
 * default such as `kimi-k3` must resolve then. So the list is registered from a
 * cache file while this extension loads, and refreshed from the catalog that
 * meter.ts fetches each session. With no cache yet, models.json is the fallback.
 *
 * The catalog says which models take images (`input_modalities`) and which reason
 * (`reasoning`); lib/model-capabilities.ts fills in what it doesn't say, and the user's
 * model-capabilities.json overrides both. Models that take images are marked "(vision)" in /model.
 *
 * Reasoning is on by default at the gateway, and NusaGate asks clients not to send
 * `reasoning_effort`: it behaves differently from model to model. So it is never sent, even
 * when an older models.json asks for it. Only DeepSeek models are registered as reasoning
 * models in pi, because only they are verified to take the `thinking` switch that pi's
 * thinking level turns on and off; for any other model that level would change nothing.
 * Rupiah costs stay in meter.ts, so pi's dollar cost stays zero.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CATALOG_CHANNEL } from "./meter.ts";
import { agentDir } from "../lib/home.ts";
import { readCapabilities, resolveCapabilities } from "../lib/model-capabilities.ts";

const PROVIDER = "nusagate";
const BASE_URL = "https://api.nusagate.com/v1";
const CACHE_FILE = "nusagate-models.json";
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Models verified to take the gateway's `thinking` switch, so pi's thinking level works on them. */
const THINKING_SWITCH = /^deepseek-/;

export type CatalogModel = { id: string; name: string; contextWindow: number; vision?: boolean; reasoning?: boolean };

/**
 * Whether a catalog row says the model takes images. The catalog has no such field
 * yet; these are the shapes gateways commonly use, so it is picked up when it lands.
 */
function catalogVision(entry: Record<string, unknown>): boolean | undefined {
  if (typeof entry.vision === "boolean") return entry.vision;
  const lists = [
    entry.input_modalities,
    entry.inputModalities,
    (entry.modalities as Record<string, unknown> | undefined)?.input,
    (entry.architecture as Record<string, unknown> | undefined)?.input_modalities,
  ];
  const list = lists.find(Array.isArray) as unknown[] | undefined;
  return list ? list.includes("image") : undefined;
}

/** The usable rows of a catalog response; rows without an id are dropped. */
export function parseCatalog(rows: unknown): CatalogModel[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const entry = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
    if (typeof entry.id !== "string" || !entry.id) return [];
    const name = typeof entry.displayName === "string" && entry.displayName ? entry.displayName : entry.id;
    const context = entry.contextLength;
    const contextWindow = typeof context === "number" && context > 0 ? context : DEFAULT_CONTEXT_WINDOW;
    const vision = catalogVision(entry);
    const reasoning = typeof entry.reasoning === "boolean" ? entry.reasoning : undefined;
    return [{ id: entry.id, name, contextWindow, ...(vision === undefined ? {} : { vision }), ...(reasoning === undefined ? {} : { reasoning }) }];
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
  const rows = models.map(({ id, name, contextWindow, vision, reasoning }) => ({
    id,
    displayName: name,
    contextLength: contextWindow,
    ...(vision === undefined ? {} : { vision }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }));
  writeFileSync(temp, `${JSON.stringify({ models: rows }, null, 2)}\n`);
  renameSync(temp, target);
}

/** A DeepSeek model, unless the catalog says it doesn't reason at all. */
export function thinkingSwitch(model: CatalogModel): boolean {
  return THINKING_SWITCH.test(model.id) && model.reasoning !== false;
}

/**
 * The request body without `reasoning_effort`, for a request to NusaGate; anything else is
 * returned as it came. Null when there is nothing to change.
 */
export function withoutReasoningEffort(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || !("reasoning_effort" in payload)) return null;
  const { reasoning_effort: _dropped, ...rest } = payload as Record<string, unknown>;
  return rest;
}

function register(pi: ExtensionAPI, models: CatalogModel[]): void {
  const overrides = readCapabilities(homeDir());
  pi.registerProvider(PROVIDER, {
    name: "NusaGate",
    baseUrl: BASE_URL,
    apiKey: "$NUSAGATE_API_KEY",
    api: "openai-completions",
    models: models.map((model) => {
      const caps = resolveCapabilities(model.id, model.contextWindow, overrides, model.vision);
      return {
        id: model.id,
        name: caps.vision ? `${model.name} (vision)` : model.name,
        ...(thinkingSwitch(model)
          ? { reasoning: true, compat: { thinkingFormat: "deepseek" as const, supportsReasoningEffort: false } }
          : { reasoning: false }),
        input: caps.vision ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: caps.contextWindow,
        maxTokens: caps.maxOutput,
      };
    }),
  });
}

export default function models(pi: ExtensionAPI) {
  let current = readCache(homeDir());
  if (current.length > 0) register(pi, current);

  // models.json files seeded before this change still ask for reasoning_effort.
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return undefined;
    return withoutReasoningEffort(event.payload) ?? undefined;
  });

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
