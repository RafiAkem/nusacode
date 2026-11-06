/**
 * Cost estimates before money is spent.
 *
 * - A large message gets a notice with its approximate price, and a question first when
 *   that price is high, so pasting a whole log file never surprises you. The reply isn't
 *   included: its length isn't known until the model has written it.
 * - Several subagents started in one go get a total, from what the ones so far cost.
 *
 * Prices come from the catalog the meter fetches, and actual spending from COST_CHANNEL;
 * nothing is priced twice and no price is hardcoded here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  NOTICE_TOKENS,
  confirmThreshold,
  describeEstimate,
  describeFanOut,
  estimateRequest,
  estimateTokens,
} from "../lib/estimate.ts";
import { CATALOG_CHANNEL, COST_CHANNEL, parsePrice, type CostEvent, type Price } from "./meter.ts";

const PROVIDER = "nusagate";
const TASK_TOOL = "task";

type Row = { id?: unknown };

export default function estimate(pi: ExtensionAPI) {
  let prices = new Map<string, Price>();
  let subagentIdr = 0;
  /** Subagent runs that finished. Blocked, failed and still-running calls don't count: they would make the average too low. */
  let subagentRuns = 0;

  pi.events.on(CATALOG_CHANNEL, (rows) => {
    if (!Array.isArray(rows)) return;
    const next = new Map<string, Price>();
    for (const row of rows as Row[]) {
      const price = parsePrice(row);
      if (typeof row?.id === "string" && price) next.set(row.id, price);
    }
    if (next.size > 0) prices = next;
  });

  pi.events.on(COST_CHANNEL, (data) => {
    const event = data as CostEvent;
    if (event.source === "subagent") subagentIdr += event.costIdr;
  });

  pi.on("session_start", () => {
    subagentIdr = 0;
    subagentRuns = 0;
  });

  pi.on("input", async (event, ctx) => {
    const tokens = estimateTokens(event.text);
    if (tokens < NOTICE_TOKENS) return { action: "continue" as const };
    const price = ctx.model?.provider === PROVIDER ? prices.get(ctx.model.id) : undefined;
    if (!price) return { action: "continue" as const };

    const context = ctx.getContextUsage()?.tokens ?? null;
    const estimated = estimateRequest(price, tokens, context);
    const line = describeEstimate(estimated);
    const threshold = confirmThreshold(process.env.NUSACODE_CONFIRM_ABOVE);
    // A message queued while the agent is running can't be held back the same way.
    const askFirst = threshold !== null && estimated.totalIdr >= threshold && ctx.hasUI && !event.streamingBehavior;
    if (askFirst) {
      const send = await ctx.ui.confirm("Send this large message?", `${line}\nTo skip this question, set NUSACODE_CONFIRM_ABOVE=off.`);
      if (!send) {
        ctx.ui.setEditorText(event.text);
        return { action: "handled" as const };
      }
    } else {
      ctx.ui.notify(line, "info");
    }
    return { action: "continue" as const };
  });

  // A response that calls `task` several times starts that many subagents together.
  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    const started = message.content.filter((block) => (block as { type?: string; name?: string }).type === "toolCall" && (block as { name?: string }).name === TASK_TOOL).length;
    if (started >= 2 && subagentRuns > 0) {
      ctx.ui.notify(describeFanOut(started, subagentIdr / subagentRuns), "info");
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === TASK_TOOL && !event.isError) subagentRuns += 1;
    return undefined;
  });
}
