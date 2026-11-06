import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a model can take and give, which NusaGate's catalog does not say.
 *
 * Only facts that were checked against the gateway belong in `BUILT_IN`. For any other
 * model, the user can add what they know to `model-capabilities.json` in the NusaCode home:
 *
 *   { "gpt-6-sol": { "vision": true, "maxOutput": 32768 }, "kimi-*": { "maxOutput": 8192 } }
 *
 * Keys are a model id, or an id prefix ending in `*`. An exact id beats a prefix, a longer
 * prefix beats a shorter one, and the user's file beats `BUILT_IN`.
 */
export type Capabilities = {
  /** Accepts image input. */
  vision?: boolean;
  /** Most tokens one response may hold. */
  maxOutput?: number;
  /** Prompt window, replacing the catalog's figure. */
  contextWindow?: number;
};

export const CAPABILITIES_FILE = "model-capabilities.json";
export const DEFAULT_MAX_OUTPUT = 16_384;

/**
 * Checked on 2026-11-07 by sending each catalog model a solid red and a solid blue
 * image through the gateway: these named both colours. The rest either got a 400
 * ("does not accept images") or answered as if no image had arrived, which is what
 * the GPT and Grok models on the gateway did, so marking them would only send
 * pictures that are dropped on the way.
 */
export const BUILT_IN: Record<string, Capabilities> = {
  "deepseek-v4.1-flash": { vision: true },
  "gemini-3.8-flash": { vision: true },
  "glm-5.3-flash": { vision: true },
  "gpt-5.6-terra": { vision: true },
  "kimi-k3": { vision: true },
  "kimi-k3.1-pro": { vision: true },
  "qwen3.8-flash": { vision: true },
  "qwen3.8-max-0902": { vision: true },
};

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** One entry, keeping only the fields that make sense; anything else is ignored. */
export function parseCapabilities(value: unknown): Capabilities {
  const entry = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const result: Capabilities = {};
  if (typeof entry.vision === "boolean") result.vision = entry.vision;
  if (positiveInteger(entry.maxOutput)) result.maxOutput = entry.maxOutput;
  if (positiveInteger(entry.contextWindow)) result.contextWindow = entry.contextWindow;
  return result;
}

/** The user's file, or nothing when it is missing or unreadable. */
export function readCapabilities(dir: string): Record<string, Capabilities> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, CAPABILITIES_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, parseCapabilities(value)]));
  } catch {
    return {};
  }
}

/** How well `key` fits `id`: exact is best, then the longest prefix; -1 when it does not fit. */
function specificity(key: string, id: string): number {
  if (key === id) return Number.MAX_SAFE_INTEGER;
  return key.endsWith("*") && id.startsWith(key.slice(0, -1)) ? key.length : -1;
}

/** Merges every entry that fits `id`, least specific first, so the most specific one wins per field. */
function lookup(table: Record<string, Capabilities>, id: string): Capabilities {
  return Object.entries(table)
    .map(([key, caps]) => ({ caps, rank: specificity(key, id) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .reduce<Capabilities>((merged, { caps }) => ({ ...merged, ...caps }), {});
}

export type ResolvedCapabilities = { vision: boolean; maxOutput: number; contextWindow: number };

/**
 * A model's capabilities: the user's file over what the catalog says over the
 * built-in table over the defaults. The catalog says nothing about vision today;
 * `catalogVision` is there for when it does.
 */
export function resolveCapabilities(
  id: string,
  catalogContextWindow: number,
  overrides: Record<string, Capabilities> = {},
  catalogVision?: boolean,
): ResolvedCapabilities {
  const fromCatalog: Capabilities = catalogVision === undefined ? {} : { vision: catalogVision };
  const merged = { ...lookup(BUILT_IN, id), ...fromCatalog, ...lookup(overrides, id) };
  const contextWindow = merged.contextWindow ?? catalogContextWindow;
  return {
    vision: merged.vision ?? false,
    // A response can't be longer than the window it has to fit in, whoever set the limit.
    maxOutput: Math.min(merged.maxOutput ?? DEFAULT_MAX_OUTPUT, contextWindow),
    contextWindow,
  };
}
