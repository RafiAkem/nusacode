/**
 * NusaCode cost meter.
 *
 * Token counts come from the provider response (the assistant message `usage`
 * that pi normalizes from the upstream `usage` object). Rupiah prices are
 * fetched once per session from NusaGate's public model catalog and applied
 * per response with the same formula the gateway uses to bill (per-request
 * ceil), so the meter tracks the invoice instead of an estimate.
 *
 * NusaGate returns no cost field in chat responses, so cost = tokens x fetched
 * price. Balance comes from `GET /v1/balance`, authenticated with the same API
 * key. No price is hardcoded here.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODELS_URL = "https://api.nusagate.com/api/public/models";
export const BALANCE_URL = "https://api.nusagate.com/v1/balance";
/** setup.ts publishes a key entered during the session here. */
export const KEY_CHANNEL = "nusacode:api-key";
const TOPUP_URL = "https://nusagate.com/dashboard/wallet";
const PROVIDER = "nusagate";
const STATUS_KEY = "nusa-meter";
/** Shared extension event bus channel; subagents.ts publishes child usage here. */
const USAGE_CHANNEL = "nusacode:usage";
/** Wallet and price rows for the startup screen in brand.ts. */
export const SUMMARY_CHANNEL = "nusacode:usage-summary";
/** Raw catalog rows, for the model list in models.ts. */
export const CATALOG_CHANNEL = "nusacode:catalog";
const FETCH_TIMEOUT_MS = 5_000;
/** Below this the report carries the topup link. */
const LOW_BALANCE_IDR = 5_000;
const MIN_SPEED_SAMPLE_MS = 50;
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

/** Wallet state from `/v1/balance`. */
type Balance = {
  balanceIdr: number;
  /** Monthly pass, when the account has one: its own quota on top of the wallet. */
  pass: { totalIdr: number; remainingIdr: number; endsAt: string } | null;
};

export type SummaryRow = { label: string; value: string; warn?: boolean };

type Totals = {
  requests: number;
  /** Prompt tokens billed at the full input price (pi `input` + `cacheWrite`). */
  freshInput: number;
  cacheRead: number;
  output: number;
  costIdr: number;
  /** Fresh input and output tokens at the vendor's official USD price. */
  officialIdr: number;
  /** The same tokens at NusaGate's price, unrounded, for a like-for-like saving. */
  comparableIdr: number;
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
  comparableIdr: 0,
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

function tokensPerSecond(output: number, elapsedMs: number): number {
  return output / (elapsedMs / 1_000);
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%";
}

/** Report rows are aligned on a label column so the panel reads as a table. */
const LABEL_WIDTH = 14;

function row(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

/** Fraction as a solid/empty bar, e.g. `████████░░░░░░░░`. */
function bar(part: number, whole: number, width = 16): string {
  const filled = whole > 0 ? Math.round(Math.min(1, Math.max(0, part / whole)) * width) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
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

async function fetchPrices(url: string, onCatalog: (rows: unknown[]) => void): Promise<Map<string, Price>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = asRecord(await res.json());
  const rows = body && Array.isArray(body.data) ? body.data : [];
  onCatalog(rows);
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

function parseBalance(body: unknown): Balance {
  const root = asRecord(body);
  const balanceIdr = root ? readNumber(root, "balance") : null;
  if (balanceIdr === null) throw new Error("no balance in response");
  const pass = root ? asRecord(root.pass) : null;
  const totalIdr = pass ? readNumber(pass, "valueTotalIdr") : null;
  const remainingIdr = pass ? readNumber(pass, "valueRemainingIdr") : null;
  const endsAt = pass?.endsAt;
  return {
    balanceIdr,
    pass:
      totalIdr !== null && remainingIdr !== null && typeof endsAt === "string"
        ? { totalIdr, remainingIdr, endsAt }
        : null,
  };
}

async function fetchBalance(url: string, key: string): Promise<Balance> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseBalance(await res.json());
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
  let apiKey: string | undefined;
  let balance: Balance | null = null;
  let balanceError: string | null = null;
  /** Last context seen, so a bus event from a subagent can refresh the statusline. */
  let lastCtx: ExtensionContext | null = null;
  /** When the current response's first chunk arrived. */
  let firstChunkAt: number | null = null;
  let lastSpeed: number | null = null;
  let speedTokens = 0;
  let speedMs = 0;

  /** Best-effort wallet refresh; failures keep the last known balance. */
  async function refreshBalance(key: string | undefined): Promise<void> {
    if (!key) {
      balanceError = "NusaGate API key not found";
      return;
    }
    try {
      balance = await fetchBalance(process.env.NUSAGATE_BALANCE_URL || BALANCE_URL, key);
      balanceError = null;
    } catch (err) {
      balanceError = err instanceof Error ? err.message : String(err);
    }
  }

  function balanceRows(): string[] {
    if (!balance) return [row("Balance", `unavailable (${balanceError ?? "unknown"})`)];
    const lines = [row("Balance", idr(balance.balanceIdr))];
    if (balance.pass) {
      const { remainingIdr, totalIdr, endsAt } = balance.pass;
      lines.push(row("Pass", `${idr(remainingIdr)} left of ${idr(totalIdr)} · until ${endsAt.slice(0, 10)}`));
    }
    if (balance.balanceIdr < LOW_BALANCE_IDR) lines.push(`Low balance · top up: ${topupLink()}`);
    return lines;
  }

  function statusText(): string {
    const used = totalTokens(totals);
    if (totals.requests === 0) {
      if (prices) return "nusa · no usage yet";
      return priceError ? "nusa · prices unavailable" : "nusa · loading prices...";
    }
    if (!prices) return `nusa · ${tokens(used)} tok · cost unavailable`;
    const prefix = totals.unpriced > 0 ? "≥ " : "";
    const prompt = totals.freshInput + totals.cacheRead;
    const cache = prompt > 0 ? ` · cache ${percent(totals.cacheRead, prompt)}` : "";
    const speed = lastSpeed === null ? "" : ` · ${Math.round(lastSpeed)} tok/s`;
    return `nusa · ${prefix}${idr(totals.costIdr)} · ${tokens(used)} tok${cache}${speed}`;
  }

  function summaryRows(modelId: string | undefined): SummaryRow[] {
    const rows: SummaryRow[] = [];
    if (balance) {
      const low = balance.balanceIdr < LOW_BALANCE_IDR;
      rows.push({
        label: "Balance",
        value: low ? `${idr(balance.balanceIdr)} · low, /topup` : idr(balance.balanceIdr),
        warn: low,
      });
      if (balance.pass) {
        const { remainingIdr, totalIdr, endsAt } = balance.pass;
        rows.push({
          label: "Pass",
          value: `${idr(remainingIdr)} left of ${idr(totalIdr)} · until ${endsAt.slice(0, 10)}`,
        });
      }
    } else {
      rows.push({ label: "Balance", value: balanceError ? `unavailable (${balanceError})` : "loading...", warn: !!balanceError });
    }
    if (!prices) {
      rows.push({ label: "Price", value: priceError ? "unavailable" : "loading..." });
      return rows;
    }
    const price = modelId === undefined ? undefined : prices.get(modelId);
    if (!price) {
      rows.push({ label: "Price", value: "model not in catalog" });
      return rows;
    }
    rows.push({ label: "Price", value: `${idr(price.inputPer1M)} input · ${idr(price.outputPer1M)} output /1M` });
    if (price.officialInputPer1M !== null && price.officialOutputPer1M !== null) {
      const official = price.officialInputPer1M + price.officialOutputPer1M;
      rows.push({ label: "Saved", value: `${percent(official - price.inputPer1M - price.outputPer1M, official)} vs list price` });
    }
    return rows;
  }

  function publishSummary(provider: string | undefined, modelId: string | undefined): void {
    pi.events.emit(SUMMARY_CHANNEL, { rows: summaryRows(provider === PROVIDER ? modelId : undefined) });
  }

  function refreshStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, statusText());
    publishSummary(ctx.model?.provider, ctx.model?.id);
  }

  function unavailableLine(): string {
    return `Cost unavailable (price fetch failed: ${priceError ?? "unknown"})`;
  }

  function report(): string {
    const used = totalTokens(totals);
    const prompt = totals.freshInput + totals.cacheRead;
    const header = `NusaCode · ${[...modelsUsed].join(", ") || "no model yet"}`;
    const lines = [header, "─".repeat(Math.max(header.length, 32))];
    if (totals.requests === 0) {
      lines.push("No usage in this session yet.");
      lines.push(prices ? `Prices: ${priceSource} (fetched once at session start)` : unavailableLine());
      lines.push(...balanceRows());
      return lines.join("\n");
    }
    const requestValue = [`${totals.requests}`];
    if (totals.subagentRequests > 0) {
      requestValue.push(`subagent ${totals.subagentRequests} · ${tokens(totals.subagentTokens)} tok`);
    }
    lines.push(row("Requests", requestValue.join(" · ")));
    lines.push(
      row(
        "Tokens",
        `${tokens(used)} · input ${tokens(totals.freshInput)} · cache ${tokens(totals.cacheRead)} · output ${tokens(totals.output)}`,
      ),
    );
    if (used > 0) {
      lines.push(row("Cache hit", `${bar(totals.cacheRead, prompt)} ${percent(totals.cacheRead, prompt)}`));
    }
    if (lastSpeed !== null) {
      const average = Math.round(tokensPerSecond(speedTokens, speedMs));
      lines.push(row("Speed", `${Math.round(lastSpeed)} tok/s last · ${average} tok/s average`));
    }
    if (prices) {
      lines.push(row("Session cost", idr(totals.costIdr)));
      if (totals.officialIdr > 0) {
        lines.push(
          row(
            "List price",
            `${idr(totals.officialIdr)} · saved ${percent(totals.officialIdr - totals.comparableIdr, totals.officialIdr)} (excl. cached tokens)`,
          ),
        );
      }
      if (totals.unpriced > 0) lines.push(`${totals.unpriced} response(s) without a price (model not in catalog)`);
      lines.push(`Prices: ${priceSource} (fetched once at session start)`);
    } else {
      lines.push(unavailableLine());
    }
    lines.push(...balanceRows());
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
    balance = null;
    balanceError = null;
    priceSource = process.env.NUSAGATE_MODELS_URL || MODELS_URL;
    firstChunkAt = null;
    lastSpeed = null;
    speedTokens = 0;
    speedMs = 0;
    refreshStatus(ctx);
    const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER).catch(() => undefined);
    keyId = key ? shortKeyId(key) : null;
    apiKey = key;
    // Prices and wallet are independent; one failing must not hide the other.
    await Promise.all([
      fetchPrices(priceSource, (rows) => pi.events.emit(CATALOG_CHANNEL, rows)).then(
        (result) => {
          prices = result;
        },
        (err) => {
          priceError = err instanceof Error ? err.message : String(err);
        },
      ),
      refreshBalance(key),
    ]);
    refreshStatus(ctx);
  });

  function recordSpeed(output: number, elapsedMs: number): void {
    // A reply that arrives as one chunk has no measurable streaming time.
    if (output <= 0 || elapsedMs < MIN_SPEED_SAMPLE_MS) return;
    lastSpeed = tokensPerSecond(output, elapsedMs);
    speedTokens += output;
    speedMs += elapsedMs;
  }

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
    // Cached tokens are left out on both sides: the catalog has no official cache
    // price, and charging them at the full input rate would overstate the saving.
    if (price.officialInputPer1M !== null && price.officialOutputPer1M !== null) {
      const perMillion = (input: number, output: number) => (fresh / 1_000_000) * input + (usage.output / 1_000_000) * output;
      totals.officialIdr += perMillion(price.officialInputPer1M, price.officialOutputPer1M);
      totals.comparableIdr += perMillion(price.inputPer1M, price.outputPer1M);
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
    if (firstChunkAt !== null) recordSpeed(message.usage.output, Date.now() - firstChunkAt);
    firstChunkAt = null;
    refreshStatus(ctx);
  });

  // Speed is timed from the first streamed chunk, so waiting on the model to
  // start replying doesn't count against it.
  pi.on("message_update", (event) => {
    if (event.message.role === "assistant" && firstChunkAt === null) firstChunkAt = Date.now();
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

  pi.on("model_select", (event) => {
    publishSummary(event.model.provider, event.model.id);
  });

  pi.events.on(KEY_CHANNEL, (data) => {
    const key = asRecord(data)?.key;
    if (typeof key !== "string") return;
    apiKey = key;
    keyId = shortKeyId(key);
    void refreshBalance(key).then(() => {
      if (lastCtx) refreshStatus(lastCtx);
    });
  });

  pi.on("turn_end", (_event, ctx) => {
    lastCtx = ctx;
    refreshStatus(ctx);
  });

  pi.registerCommand("usage", {
    description: "Show the session cost meter (rupiah, tokens, savings)",
    handler: async (_args, ctx) => {
      // Refetch the wallet so the report reflects charges made since startup.
      await refreshBalance(apiKey);
      ctx.ui.notify(report(), "info");
    },
  });

  pi.registerCommand("topup", {
    description: "Show your balance and a NusaGate top-up link",
    handler: async (_args, ctx) => {
      await refreshBalance(apiKey);
      const summary = balance ? `Balance: ${idr(balance.balanceIdr)}` : `Balance unavailable (${balanceError ?? "unknown"})`;
      ctx.ui.notify(`${summary}\nTop up: ${topupLink()}`, "info");
    },
  });
}
