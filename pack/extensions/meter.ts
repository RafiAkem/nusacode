/**
 * NusaCode cost meter.
 *
 * Token counts come from the provider response (the assistant message `usage`
 * that pi normalizes from the upstream `usage` object). Each NusaGate response
 * also says what it was billed, `usage.cost_idr`, and that is the cost the meter
 * counts. pi drops that field when it normalizes usage, so it is read from the raw
 * stream (`provider_stream_event`).
 *
 * Rupiah prices are fetched once per session from NusaGate's public model catalog.
 * They price what carries no billed amount (subagents, which run in their own
 * process) with the gateway's own formula (per-request ceil), and give the list-price
 * comparison. Balance comes from `GET /v1/balance`, authenticated with the same API
 * key. No price is hardcoded here.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/home.ts";
import { idr, USD_IDR } from "../lib/money.ts";
import { historyReport, parsePeriod, periodRows, readLog } from "../lib/usage-log.ts";
import { messages } from "../lib/i18n.ts";

const t = messages(
  {
    balance: "Balance",
    pass: "Pass",
    price: "Price",
    saved: "Saved",
    requests: "Requests",
    tokens: "Tokens",
    cacheHit: "Cache hit",
    speed: "Speed",
    sessionCost: "Session cost",
    listPrice: "List price",
    unknown: "unknown",
    keyNotFound: "NusaGate API key not found",
    unavailable: "unavailable",
    unavailableWhy: "unavailable ({reason})",
    loading: "loading...",
    passLeft: "{left} left of {total} · until {date}",
    lowBalanceTopup: "Low balance · top up: {link}",
    lowBalanceShort: "{amount} · low, /topup",
    notInCatalog: "model not in catalog",
    priceValue: "{input} input · {output} output /1M",
    savedValue: "{percent} vs list price",
    statusNoUsage: "nusa · no usage yet",
    statusPricesUnavailable: "nusa · prices unavailable",
    statusLoadingPrices: "nusa · loading prices...",
    statusCostUnavailable: "nusa · {tokens} tok · cost unavailable",
    moreHistory: "More: /usage history",
    costUnavailable: "Cost unavailable (price fetch failed: {reason})",
    noModelYet: "no model yet",
    noUsageSession: "No usage in this session yet.",
    pricesSource: "Prices: {source} (fetched once at session start)",
    speedValue: "{last} tok/s last · {average} tok/s average",
    listPriceValue: "{official} · saved {percent} (excl. cached tokens)",
    unpricedResponses: "{count} response(s) without a price (model not in catalog)",
    usageDescription: "Show the session cost meter (rupiah, tokens, savings). `/usage history` shows spending over time",
    usageHistoryUsage: "Usage: /usage history [today|week|month|all]",
    topupDescription: "Show your balance and a NusaGate top-up link",
    topupBalance: "Balance: {amount}",
    topupBalanceUnavailable: "Balance unavailable ({reason})",
    topupLink: "Top up: {link}",
  },
  {
    balance: "Saldo",
    pass: "Pass",
    price: "Harga",
    saved: "Hemat",
    requests: "Permintaan",
    tokens: "Token",
    cacheHit: "Cache hit",
    speed: "Kecepatan",
    sessionCost: "Biaya sesi",
    listPrice: "Harga resmi",
    unknown: "tidak diketahui",
    keyNotFound: "API key NusaGate tidak ditemukan",
    unavailable: "tidak tersedia",
    unavailableWhy: "tidak tersedia ({reason})",
    loading: "memuat...",
    passLeft: "sisa {left} dari {total} · berakhir {date}",
    lowBalanceTopup: "Saldo menipis · top up: {link}",
    lowBalanceShort: "{amount} · menipis, /topup",
    notInCatalog: "model tidak ada di katalog",
    priceValue: "{input} input · {output} output /1M",
    savedValue: "{percent} dibanding harga resmi",
    statusNoUsage: "nusa · belum ada pemakaian",
    statusPricesUnavailable: "nusa · harga tidak tersedia",
    statusLoadingPrices: "nusa · memuat harga...",
    statusCostUnavailable: "nusa · {tokens} tok · biaya tidak tersedia",
    moreHistory: "Selengkapnya: /usage history",
    costUnavailable: "Biaya tidak tersedia (gagal mengambil harga: {reason})",
    noModelYet: "belum ada model",
    noUsageSession: "Belum ada pemakaian di sesi ini.",
    pricesSource: "Harga: {source} (diambil sekali saat sesi dimulai)",
    speedValue: "{last} tok/s terakhir · rata-rata {average} tok/s",
    listPriceValue: "{official} · hemat {percent} (tidak termasuk token dari cache)",
    unpricedResponses: "{count} respons tanpa harga (model tidak ada di katalog)",
    usageDescription: "Tampilkan meteran biaya sesi (rupiah, token, penghematan). `/usage history` menampilkan pengeluaran dari waktu ke waktu",
    usageHistoryUsage: "Cara pakai: /usage history [today|week|month|all]",
    topupDescription: "Tampilkan saldo kamu dan link top up NusaGate",
    topupBalance: "Saldo: {amount}",
    topupBalanceUnavailable: "Saldo tidak tersedia ({reason})",
    topupLink: "Top up: {link}",
  },
);

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
/** One event per response, so budget.ts and others can follow spending without pricing anything. */
export const COST_CHANNEL = "nusacode:cost";

/** What the meter publishes on COST_CHANNEL after it accounts for one response. */
export type CostEvent = {
  provider: string;
  model: string;
  /** The response's own cost, in whole rupiah; 0 when the model had no price. */
  costIdr: number;
  /** The session's cost so far, subagents included. */
  sessionIdr: number;
  /** True when the model had no price, so the cost is a minimum rather than the cost. */
  unpriced: boolean;
  /** Prompt tokens at the full input price, tokens read from cache, and tokens written. */
  freshInput: number;
  cacheRead: number;
  output: number;
  source: "main" | "subagent";
};
const FETCH_TIMEOUT_MS = 5_000;
/** Below this the report carries the topup link. */
const LOW_BALANCE_IDR = 5_000;
const MIN_SPEED_SAMPLE_MS = 50;
/** Stored as the balance error when there is no key; shown translated. */
const MISSING_KEY = "NusaGate API key not found";

type Json = Record<string, unknown>;

export type Price = {
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

export function parsePrice(row: unknown): Price | null {
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

/**
 * What NusaGate billed for a response: `usage.cost_idr` on the final chunk of the stream.
 * Null for any other chunk, or a value that isn't a sensible amount.
 */
export function billedCost(chunk: unknown): number | null {
  const usage = asRecord(asRecord(chunk)?.usage);
  const cost = usage?.cost_idr;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** Same arithmetic as the gateway's computeCost(): whole rupiah, rounded up per request. Used when a response carries no billed cost. */
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
  /** What NusaGate billed for the response being streamed, once its final chunk arrives. */
  let billedIdr: number | null = null;

  /** Best-effort wallet refresh; failures keep the last known balance. */
  async function refreshBalance(key: string | undefined): Promise<void> {
    if (!key) {
      balanceError = MISSING_KEY;
      return;
    }
    try {
      balance = await fetchBalance(process.env.NUSAGATE_BALANCE_URL || BALANCE_URL, key);
      balanceError = null;
    } catch (err) {
      balanceError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Why the balance is missing, in the language in use. */
  function balanceReason(): string {
    if (balanceError === MISSING_KEY) return t("keyNotFound");
    return balanceError ?? t("unknown");
  }

  function passValue(pass: NonNullable<Balance["pass"]>): string {
    return t("passLeft", { left: idr(pass.remainingIdr), total: idr(pass.totalIdr), date: pass.endsAt.slice(0, 10) });
  }

  function balanceRows(): string[] {
    if (!balance) return [row(t("balance"), t("unavailableWhy", { reason: balanceReason() }))];
    const lines = [row(t("balance"), idr(balance.balanceIdr))];
    if (balance.pass) lines.push(row(t("pass"), passValue(balance.pass)));
    if (balance.balanceIdr < LOW_BALANCE_IDR) lines.push(t("lowBalanceTopup", { link: topupLink() }));
    return lines;
  }

  function statusText(): string {
    const used = totalTokens(totals);
    if (totals.requests === 0) {
      if (prices) return t("statusNoUsage");
      return priceError ? t("statusPricesUnavailable") : t("statusLoadingPrices");
    }
    if (!prices) return t("statusCostUnavailable", { tokens: tokens(used) });
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
        label: t("balance"),
        value: low ? t("lowBalanceShort", { amount: idr(balance.balanceIdr) }) : idr(balance.balanceIdr),
        warn: low,
      });
      if (balance.pass) rows.push({ label: t("pass"), value: passValue(balance.pass) });
    } else {
      rows.push({
        label: t("balance"),
        value: balanceError ? t("unavailableWhy", { reason: balanceReason() }) : t("loading"),
        warn: !!balanceError,
      });
    }
    if (!prices) {
      rows.push({ label: t("price"), value: priceError ? t("unavailable") : t("loading") });
      return rows;
    }
    const price = modelId === undefined ? undefined : prices.get(modelId);
    if (!price) {
      rows.push({ label: t("price"), value: t("notInCatalog") });
      return rows;
    }
    rows.push({ label: t("price"), value: t("priceValue", { input: idr(price.inputPer1M), output: idr(price.outputPer1M) }) });
    if (price.officialInputPer1M !== null && price.officialOutputPer1M !== null) {
      const official = price.officialInputPer1M + price.officialOutputPer1M;
      rows.push({
        label: t("saved"),
        value: t("savedValue", { percent: percent(official - price.inputPer1M - price.outputPer1M, official) }),
      });
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

  /** Today and this month across all sessions, from the saved history. */
  function historyRows(): string[] {
    const rows = periodRows(readLog(agentDir()), new Date());
    return rows.length === 0 ? [] : [...rows.map(([label, value]) => row(label, value)), t("moreHistory")];
  }

  function unavailableLine(): string {
    return t("costUnavailable", { reason: priceError ?? t("unknown") });
  }

  function report(): string {
    const used = totalTokens(totals);
    const prompt = totals.freshInput + totals.cacheRead;
    const header = `NusaCode · ${[...modelsUsed].join(", ") || t("noModelYet")}`;
    const lines = [header, "─".repeat(Math.max(header.length, 32))];
    if (totals.requests === 0) {
      lines.push(t("noUsageSession"));
      lines.push(prices ? t("pricesSource", { source: priceSource }) : unavailableLine());
      lines.push(...historyRows());
      lines.push(...balanceRows());
      return lines.join("\n");
    }
    const requestValue = [`${totals.requests}`];
    if (totals.subagentRequests > 0) {
      requestValue.push(`subagent ${totals.subagentRequests} · ${tokens(totals.subagentTokens)} tok`);
    }
    lines.push(row(t("requests"), requestValue.join(" · ")));
    lines.push(
      row(
        t("tokens"),
        `${tokens(used)} · input ${tokens(totals.freshInput)} · cache ${tokens(totals.cacheRead)} · output ${tokens(totals.output)}`,
      ),
    );
    if (used > 0) {
      lines.push(row(t("cacheHit"), `${bar(totals.cacheRead, prompt)} ${percent(totals.cacheRead, prompt)}`));
    }
    if (lastSpeed !== null) {
      const average = Math.round(tokensPerSecond(speedTokens, speedMs));
      lines.push(row(t("speed"), t("speedValue", { last: Math.round(lastSpeed), average })));
    }
    if (prices) {
      lines.push(row(t("sessionCost"), idr(totals.costIdr)));
      if (totals.officialIdr > 0) {
        lines.push(
          row(
            t("listPrice"),
            t("listPriceValue", {
              official: idr(totals.officialIdr),
              percent: percent(totals.officialIdr - totals.comparableIdr, totals.officialIdr),
            }),
          ),
        );
      }
      if (totals.unpriced > 0) lines.push(t("unpricedResponses", { count: totals.unpriced }));
      lines.push(t("pricesSource", { source: priceSource }));
    } else {
      lines.push(unavailableLine());
    }
    lines.push(...historyRows());
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

  /** Folds one provider response into the session totals, and publishes it. */
  function account(provider: string, model: string, usage: UsageCounts, source: CostEvent["source"], billed: number | null = null): void {
    const before = totals.costIdr;
    const priced = fold(provider, model, usage, billed);
    pi.events.emit(COST_CHANNEL, {
      provider,
      model,
      costIdr: totals.costIdr - before,
      sessionIdr: totals.costIdr,
      unpriced: !priced,
      freshInput: usage.input + usage.cacheWrite,
      cacheRead: usage.cacheRead,
      output: usage.output,
      source,
    } satisfies CostEvent);
  }

  /**
   * Adds one response to the totals; false when its model has no price. `billed` is what
   * NusaGate charged, which wins over the estimate from the price list.
   */
  function fold(provider: string, model: string, usage: UsageCounts, billed: number | null): boolean {
    const fresh = usage.input + usage.cacheWrite;
    const cached = usage.cacheRead;
    totals.requests += 1;
    totals.freshInput += fresh;
    totals.cacheRead += cached;
    totals.output += usage.output;
    modelsUsed.add(`${provider}/${model}`);
    const price = provider === PROVIDER ? prices?.get(model) : undefined;
    if (billed !== null) totals.costIdr += billed;
    if (!price) {
      if (billed !== null) return true;
      totals.unpriced += 1;
      return false;
    }
    if (billed === null) totals.costIdr += billIdr(price, fresh, cached, usage.output);
    // Cached tokens are left out on both sides: the catalog has no official cache
    // price, and charging them at the full input rate would overstate the saving.
    if (price.officialInputPer1M !== null && price.officialOutputPer1M !== null) {
      const perMillion = (input: number, output: number) => (fresh / 1_000_000) * input + (usage.output / 1_000_000) * output;
      totals.officialIdr += perMillion(price.officialInputPer1M, price.officialOutputPer1M);
      totals.comparableIdr += perMillion(price.inputPer1M, price.outputPer1M);
    }
    return true;
  }

  // Token usage per provider response. `after_provider_response` carries only
  // status and headers in pi 1.4.0, so the normalized usage on the assistant
  // message is the earliest point where it is available.
  pi.on("message_end", (event, ctx) => {
    lastCtx = ctx;
    const message = event.message;
    if (message.role !== "assistant" || !message.usage) return;
    const billed = message.provider === PROVIDER ? billedIdr : null;
    billedIdr = null;
    account(message.provider, message.model, message.usage, "main", billed);
    if (firstChunkAt !== null) recordSpeed(message.usage.output, Date.now() - firstChunkAt);
    firstChunkAt = null;
    refreshStatus(ctx);
  });

  // A new request starts with nothing billed yet, so a failed one can't lend its cost to the next.
  pi.on("before_provider_request", () => {
    billedIdr = null;
    return undefined;
  });

  // pi keeps only token counts from a response's usage, so the billed amount is read from the
  // raw stream: the final chunk carries usage.cost_idr.
  pi.on("provider_stream_event", (event) => {
    if (event.provider !== PROVIDER) return;
    const cost = billedCost(event.data);
    if (cost !== null) billedIdr = cost;
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
    account(String(event.provider), String(event.model), counts, "subagent");
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
    description: t("usageDescription"),
    handler: async (args, ctx) => {
      const [first, ...rest] = args.trim().split(/\s+/);
      if (first?.toLowerCase() === "history") {
        const period = parsePeriod(rest.join(" "));
        if (period === null) {
          ctx.ui.notify(t("usageHistoryUsage"), "warning");
          return;
        }
        ctx.ui.notify(historyReport(readLog(agentDir()), period, new Date()), "info");
        return;
      }
      // Refetch the wallet so the report reflects charges made since startup.
      await refreshBalance(apiKey);
      ctx.ui.notify(report(), "info");
    },
  });

  pi.registerCommand("topup", {
    description: t("topupDescription"),
    handler: async (_args, ctx) => {
      await refreshBalance(apiKey);
      const summary = balance
        ? t("topupBalance", { amount: idr(balance.balanceIdr) })
        : t("topupBalanceUnavailable", { reason: balanceReason() });
      ctx.ui.notify(`${summary}\n${t("topupLink", { link: topupLink() })}`, "info");
    },
  });
}
