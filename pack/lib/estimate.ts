/**
 * Estimating what a message will cost before it is sent.
 *
 * Only the input side can be known in advance: the reply has no length until the model has
 * written it. So an estimate covers reading the new message, plus re-reading the conversation
 * so far, which providers usually serve from the cache at a fraction of the input price.
 */
import { idr, parseIdr } from "./money.ts";
import { messages } from "./i18n.ts";

const t = messages(
  {
    readIt: "{cost} to read it",
    reread: "{cost} to re-read the conversation from the cache",
    largeMessage: "Large message: about {tokens} tokens, around {total} to send ({parts}), before the reply.",
    fanOut:
      "Starting {count} subagents at once. Subagents have cost about {each} each so far in this session, so around {total} in total.",
  },
  {
    readIt: "{cost} untuk membacanya",
    reread: "{cost} untuk membaca ulang percakapan dari cache",
    largeMessage: "Pesan besar: sekitar {tokens} token, perkiraan {total} untuk dikirim ({parts}), belum termasuk balasan.",
    fanOut:
      "Menjalankan {count} subagent sekaligus. Sejauh ini di sesi ini, tiap subagent memakan biaya sekitar {each}, jadi totalnya sekitar {total}.",
  },
);

/** English text and code average a little under four characters per token. */
const CHARS_PER_TOKEN = 4;
/** A message this big gets a cost notice. */
export const NOTICE_TOKENS = 5_000;
/** An estimated input cost this high asks for confirmation first, unless NUSACODE_CONFIRM_ABOVE changes it. */
export const DEFAULT_CONFIRM_IDR = 500;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The part of a catalog price the estimate needs. */
export type InputPrice = { inputPer1M: number; cachePercent: number };

export type Estimate = {
  messageTokens: number;
  /** Conversation tokens already in the context, or null when pi can't say yet. */
  contextTokens: number | null;
  /** Reading the new message, in rupiah (unrounded). */
  messageIdr: number;
  /** Re-reading the conversation from the cache, in rupiah (unrounded). */
  contextIdr: number;
  /** What the gateway would charge for this request before any reply: rounded up, like the invoice. */
  totalIdr: number;
};

export function estimateRequest(price: InputPrice, messageTokens: number, contextTokens: number | null): Estimate {
  const messageIdr = (messageTokens / 1_000_000) * price.inputPer1M;
  const contextIdr = ((contextTokens ?? 0) / 1_000_000) * price.inputPer1M * (price.cachePercent / 100);
  return { messageTokens, contextTokens, messageIdr, contextIdr, totalIdr: Math.ceil(messageIdr + contextIdr) };
}

function tokenText(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}

/** One line for the notice, such as `Large message: about 12.0k tokens, around Rp 48 to send (...), before the reply.` */
export function describeEstimate(estimate: Estimate): string {
  const parts = [t("readIt", { cost: idr(Math.ceil(estimate.messageIdr)) })];
  if (estimate.contextTokens !== null && estimate.contextIdr > 0) {
    parts.push(t("reread", { cost: idr(Math.ceil(estimate.contextIdr)) }));
  }
  return t("largeMessage", { tokens: tokenText(estimate.messageTokens), total: idr(estimate.totalIdr), parts: parts.join(" + ") });
}

/** The confirmation threshold from NUSACODE_CONFIRM_ABOVE; `off` or `0` turns the question off. */
export function confirmThreshold(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return DEFAULT_CONFIRM_IDR;
  if (value.trim().toLowerCase() === "off" || value.trim() === "0") return null;
  return parseIdr(value) ?? DEFAULT_CONFIRM_IDR;
}

/** What several subagents started at once will probably cost, from what the ones so far cost. */
export function describeFanOut(count: number, averageIdr: number): string {
  const each = idr(Math.ceil(averageIdr));
  return t("fanOut", { count, each, total: idr(Math.ceil(averageIdr * count)) });
}
