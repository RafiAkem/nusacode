/**
 * NusaCode cost meter.
 *
 * Token counts come from the provider response (the assistant message `usage`
 * that pi normalizes from the upstream `usage` object). Rupiah prices are
 * fetched once per session from NusaGate's public model catalog and applied
 * per response with the same formula the gateway uses to bill (per-request
 * ceil), so the meter tracks the invoice instead of an estimate.
 *
 * NusaGate returns no cost field in chat responses and has no
 * API-key-authenticated balance endpoint yet, so: cost = tokens x fetched
 * price, and balance is reported as unavailable. No price is hardcoded here.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODELS_URL = "https://api.nusagate.com/api/public/models";
const TOPUP_URL = "https://nusagate.com/dashboard/wallet";
const PROVIDER = "nusagate";
const STATUS_KEY = "nusa-meter";
/** Shared extension event bus channel; subagents.ts publishes child usage here. */
const USAGE_CHANNEL = "nusacode:usage";
const FETCH_TIMEOUT_MS = 5_000;
// Display-only: mirrors NusaGate's USD_IDR_RATE to render "vs official price".
const USD_IDR = 18_000;

type Json = Record<string, unknown>;

type Price = {
  inputPer1M: number;
  outputPer1M: number;
  /** Cache-hit price as a percentage of the input price (10 = DeepSeek style). */
  cachePercent: number;
  officialInputPer1M: number | null;
  officialOutputPer1M: number | null;
};

/** Token counts for one response, in the shape pi reports them. */
type UsageCounts = { input: number; cacheRead: number; cacheWrite: number; output: number };

type Totals = {
  requests: number;
  /** Prompt tokens billed at the full input price (pi `input` + `cacheWrite`). */
  freshInput: number;
  cacheRead: number;
  output: number;
  costIdr: number;
  /** What the same tokens would cost at the vendor's official USD price. */
  officialIdr: number;
  /** Responses whose model had no price row; their cost is not in `costIdr`. */
  unpriced: number;
  /** Subagent child processes report through the extension event bus, not `message_end`. */
  subagentRequests: number;
  subagentTokens: number;
};

const ZERO_TOTALS: Totals = {
  requests: 0,
  freshInput: 0,
  cacheRead: 0,
  output: 0,
  costIdr: 0,
  officialIdr: 0,
  unpriced: 0,
  subagentRequests: 0,
  subagentTokens: 0,
};

/** JSON objects from the catalog endpoint are string-keyed by construction. */
function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function readNumber(source: Json, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function totalTokens(t: Totals): number {
  return t.freshInput + t.cacheRead + t.output;
}

function idr(n: number): string {
  return `Rp ${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%";
}

function parsePrice(row: unknown): Price | null {
  const entry = asRecord(row);
  const pricing = entry ? asRecord(entry.pricing) : null;
  if (!pricing) return null;
  const inputPer1M = readNumber(pricing, "inputPer1M");
  const outputPer1M = readNumber(pricing, "outputPer1M");
  if (inputPer1M === null || outputPer1M === null) return null;
  const cachePricePer1M = readNumber(pricing, "cachePricePer1M");
  const cachePercent =
    readNumber(pricing, "cachePricePercent") ??
    (cachePricePer1M !== null && inputPer1M > 0 ? (cachePricePer1M / inputPer1M) * 100 : 100);
  const officialInput = readNumber(pricing, "officialUsdInputPer1M");
  const officialOutput = readNumber(pricing, "officialUsdOutputPer1M");
  return {
    inputPer1M,
    outputPer1M,
    cachePercent: Math.min(100, Math.max(0, cachePercent)),
    officialInputPer1M: officialInput === null ? null : officialInput * USD_IDR,
    officialOutputPer1M: officialOutput === null ? null : officialOutput * USD_IDR,
  };
}

/** Same arithmetic as the gateway's computeCost(): whole rupiah, rounded up per request. */
function billIdr(price: Price, fresh: number, cached: number, output: number): number {
  const raw =
    (fresh / 1_000_000) * price.inputPer1M +
    (cached / 1_000_000) * price.inputPer1M * (price.cachePercent / 100) +
    (output / 1_000_000) * price.outputPer1M;
  return Math.ceil(raw);
}

async function fetchPrices(url: string): Promise<Map<string, Price>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = asRecord(await res.json());
  const rows = body && Array.isArray(body.data) ? body.data : [];
  const prices = new Map<string, Price>();
  for (const row of rows) {
    const id = asRecord(row)?.id;
    const price = parsePrice(row);
    if (typeof id === "string" && price) prices.set(id, price);
  }
  if (prices.size === 0) throw new Error("no model prices in response");
  return prices;
}

/**
 * Short public key id for topup attribution. NusaGate already stores and shows
 * this exact prefix in its dashboard (`apiKeyPrefix` = "nsk_" + 7 chars), so we
 * reuse it instead of inventing a second identity scheme. Returns null for keys
 * that are not NusaGate's, so no partial secret reaches the URL.
 */
function shortKeyId(key: string): string | null {
  return key.startsWith("nsk_") ? key.slice(0, 11) : null;
}

export default function meter(pi: ExtensionAPI) {
  let prices: Map<string, Price> | null = null;
  let priceError: string | null = null;
  let priceSource = process.env.NUSAGATE_MODELS_URL || MODELS_URL;
  // ponytail: totals are per process, not per session file. Resuming a session
  // starts the meter at zero. Upgrade: rebuild totals from the resumed branch's
  // assistant messages when users report the discrepancy.
  let totals: Totals = { ...ZERO_TOTALS };
  let modelsUsed = new Set<string>();
  let keyId: string | null = null;
  /** Last context seen, so a bus event from a subagent can refresh the statusline. */
  let lastCtx: ExtensionContext | null = null;
  // TODO(M6): NusaGate has no API-key-authenticated balance endpoint
  // (`/api/balance` needs a user session cookie; `/v1/usage` returns token
  // totals, not balance). Once one exists: show the balance, estimate remaining
  // requests, and print the topup link automatically below Rp5.000.
  const SALDO_UNAVAILABLE = "Saldo: tidak tersedia (belum ada endpoint saldo berbasis API key di NusaGate)";

  function statusText(): string {
    const used = totalTokens(totals);
    if (totals.requests === 0) {
      if (prices) return "nusa · belum ada pemakaian";
      return priceError ? "nusa · harga tidak tersedia" : "nusa · memuat harga...";
    }
    if (!prices) return `nusa · ${tokens(used)} tok · biaya tidak tersedia`;
    const prefix = totals.unpriced > 0 ? "≥ " : "";
    const saving =
      totals.officialIdr > 0 ? ` · −${percent(totals.officialIdr - totals.costIdr, totals.officialIdr)}` : "";
    return `nusa · ${prefix}${idr(totals.costIdr)} · ${tokens(used)} tok${saving}`;
  }

  function refreshStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, statusText());
  }

  function report(): string {
    const used = totalTokens(totals);
    const prompt = totals.freshInput + totals.cacheRead;
    const lines = [
      `NusaCode meter · ${[...modelsUsed].join(", ") || "belum ada model"}`,
      `Request ${totals.requests} · token ${tokens(used)} (input ${tokens(totals.freshInput)} · cache ${tokens(totals.cacheRead)} · output ${tokens(totals.output)})`,
      `Cache hit ${percent(totals.cacheRead, prompt)}`,
    ];
    if (totals.subagentRequests > 0) {
      lines.push(`Subagent ${totals.subagentRequests} request · ${tokens(totals.subagentTokens)} tok (termasuk di atas)`);
    }
    if (prices) {
      lines.push(`Biaya sesi ${idr(totals.costIdr)}`);
      if (totals.officialIdr > 0) {
        lines.push(
          `Harga resmi ${idr(totals.officialIdr)} · hemat ${percent(totals.officialIdr - totals.costIdr, totals.officialIdr)}`,
        );
      }
      if (totals.unpriced > 0) lines.push(`${totals.unpriced} respons tanpa harga (model tidak ada di katalog)`);
      lines.push(`Harga: ${priceSource} (fetch sekali saat session_start)`);
    } else {
      lines.push(`Biaya tidak tersedia (fetch harga gagal: ${priceError ?? "unknown"})`);
    }
    lines.push(SALDO_UNAVAILABLE);
    return lines.join("\n");
  }

  function topupLink(): string {
    const params = new URLSearchParams({ src: "cli" });
    if (keyId) params.set("key", keyId);
    return `${TOPUP_URL}?${params.toString()}`;
  }

  pi.on("session_start", async (_event, ctx) => {
    totals = { ...ZERO_TOTALS };
    modelsUsed = new Set();
    lastCtx = ctx;
    prices = null;
    priceError = null;
    priceSource = process.env.NUSAGATE_MODELS_URL || MODELS_URL;
    refreshStatus(ctx);
    const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER).catch(() => undefined);
    keyId = key ? shortKeyId(key) : null;
    try {
      prices = await fetchPrices(priceSource);
    } catch (err) {
      priceError = err instanceof Error ? err.message : String(err);
    }
    refreshStatus(ctx);
  });

  /** Folds one provider response into the session totals. */
  function account(provider: string, model: string, usage: UsageCounts): void {
    const fresh = usage.input + usage.cacheWrite;
    const cached = usage.cacheRead;
    totals.requests += 1;
    totals.freshInput += fresh;
    totals.cacheRead += cached;
    totals.output += usage.output;
    modelsUsed.add(`${provider}/${model}`);
    const price = provider === PROVIDER ? prices?.get(model) : undefined;
    if (!price) {
      totals.unpriced += 1;
      return;
    }
    totals.costIdr += billIdr(price, fresh, cached, usage.output);
    if (price.officialInputPer1M !== null && price.officialOutputPer1M !== null) {
      totals.officialIdr +=
        ((fresh + cached) / 1_000_000) * price.officialInputPer1M + (usage.output / 1_000_000) * price.officialOutputPer1M;
    }
  }

  // Token usage per provider response. `after_provider_response` carries only
  // status and headers in pi 1.4.0, so the normalized usage on the assistant
  // message is the earliest point where it is available.
  pi.on("message_end", (event, ctx) => {
    lastCtx = ctx;
    const message = event.message;
    if (message.role !== "assistant" || !message.usage) return;
    account(message.provider, message.model, message.usage);
    refreshStatus(ctx);
  });

  // Subagent children are separate processes, so their usage never reaches
  // `message_end` here; subagents.ts republishes it on the shared event bus.
  pi.events.on(USAGE_CHANNEL, (data) => {
    const event = asRecord(data);
    const usage = event ? asRecord(event.usage) : null;
    if (!event || event.source !== "subagent" || !usage) return;
    const counts: UsageCounts = {
      input: readNumber(usage, "input") ?? 0,
      cacheRead: readNumber(usage, "cacheRead") ?? 0,
      cacheWrite: readNumber(usage, "cacheWrite") ?? 0,
      output: readNumber(usage, "output") ?? 0,
    };
    account(String(event.provider), String(event.model), counts);
    totals.subagentRequests += 1;
    totals.subagentTokens += counts.input + counts.cacheRead + counts.cacheWrite + counts.output;
    if (lastCtx) refreshStatus(lastCtx);
  });

  pi.on("turn_end", (_event, ctx) => {
    lastCtx = ctx;
    refreshStatus(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (totals.requests === 0) return;
    refreshStatus(ctx);
    ctx.ui.notify(report(), "info");
  });

  pi.registerCommand("nusa", {
    description: "Tampilkan meter biaya sesi (rupiah, token, penghematan)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(report(), "info");
    },
  });

  pi.registerCommand("topup", {
    description: "Tampilkan link top up saldo NusaGate",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${SALDO_UNAVAILABLE} — cek di dashboard.\nTop up: ${topupLink()}`, "info");
    },
  });
}
