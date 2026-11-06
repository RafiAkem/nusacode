/**
 * /budget: spending limits for a session, so cost is something you control and not
 * just something you read about afterwards.
 *
 * - A session limit warns at 80% and stops the agent when it is reached. The next
 *   message asks whether to raise the limit, drop it, or hold off.
 * - A prompt limit warns, once, when a single prompt has cost more than you expected.
 *
 * Amounts come from meter.ts, which publishes every priced response on COST_CHANNEL
 * with the session total, so this file never prices anything itself and counts
 * subagents too. A model without a price can't be counted: with a limit set, the first such
 * response says so once, because otherwise the limit would quietly stop protecting anything.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/home.ts";
import { describe, levelOf, parseCommand, raisedLimit, readDefaults, writeDefaults, type Limits } from "../lib/budget.ts";
import { idr } from "../lib/money.ts";
import { COST_CHANNEL, type CostEvent } from "./meter.ts";

const STATUS_KEY = "nusa-budget";

export default function budget(pi: ExtensionAPI) {
  let defaults: Limits = { sessionIdr: null, turnIdr: null };
  let limits: Limits = { ...defaults };
  let spent = 0;
  let turnStart = 0;
  let unpriced = false;
  let warnedUnpriced = false;
  let warned = false;
  let stopped = false;
  let warnedTurn = false;
  /** True between a prompt starting and finishing, so background spending isn't blamed on a prompt. */
  let inPrompt = false;
  let lastCtx: ExtensionContext | null = null;

  const turnSpent = () => Math.max(0, spent - turnStart);
  const sessionOver = () => limits.sessionIdr !== null && spent >= limits.sessionIdr;

  function showStatus(ctx: ExtensionContext): void {
    if (limits.sessionIdr === null) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const left = Math.max(0, limits.sessionIdr - spent);
    ctx.ui.setStatus(STATUS_KEY, `budget ${idr(left)} left`);
  }

  /** Warns, or stops the agent, whenever spending crosses a limit. */
  function check(ctx: ExtensionContext): void {
    showStatus(ctx);
    const level = levelOf(spent, limits.sessionIdr);
    if (level === "over") {
      if (!stopped) {
        stopped = true;
        ctx.ui.notify(
          `Session budget reached: ${idr(spent)} of ${idr(limits.sessionIdr as number)}. Stopping. Send a message to raise the limit, or use /budget.`,
          "error",
        );
        if (!ctx.isIdle()) ctx.abort();
      }
    } else if (level === "warn" && !warned) {
      warned = true;
      ctx.ui.notify(`${idr(spent)} of the ${idr(limits.sessionIdr as number)} session budget is spent.`, "warning");
    }
    if (inPrompt && limits.turnIdr !== null && !warnedTurn && turnSpent() >= limits.turnIdr) {
      warnedTurn = true;
      ctx.ui.notify(`This prompt has cost ${idr(turnSpent())} so far (warning at ${idr(limits.turnIdr)}). Press escape to stop it.`, "warning");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    defaults = readDefaults(agentDir());
    limits = { ...defaults };
    spent = 0;
    turnStart = 0;
    inPrompt = false;
    unpriced = false;
    warnedUnpriced = false;
    warned = false;
    stopped = false;
    warnedTurn = false;
    showStatus(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    lastCtx = ctx;
    turnStart = spent;
    warnedTurn = false;
    inPrompt = true;
  });

  pi.on("agent_end", () => {
    inPrompt = false;
  });

  pi.on("message_end", (_event, ctx) => {
    lastCtx = ctx;
  });

  pi.events.on(COST_CHANNEL, (data) => {
    const event = data as CostEvent;
    spent = event.sessionIdr;
    if (event.unpriced) unpriced = true;
    if (!lastCtx) return;
    if (event.unpriced && limits.sessionIdr !== null && !warnedUnpriced) {
      warnedUnpriced = true;
      lastCtx.ui.notify(`A response had no price, and the budget can't count responses without a price (NusaGate's prices didn't load, or this model isn't in its catalog), so spending can pass the limit without a warning.`, "warning");
    }
    check(lastCtx);
  });

  // The abort may not land before the model asks for another tool.
  pi.on("tool_call", () => {
    if (sessionOver()) return { block: true, reason: "The session budget has been reached.", terminate: true };
    return undefined;
  });

  // After the limit is reached, a new message needs an answer first.
  pi.on("input", async (event, ctx) => {
    lastCtx = ctx;
    if (!sessionOver() || limits.sessionIdr === null) return { action: "continue" as const };
    const limit = limits.sessionIdr;
    const next = raisedLimit(spent, limit);
    if (!ctx.hasUI) {
      ctx.ui.notify(`Session budget of ${idr(limit)} reached (spent ${idr(spent)}). Nothing was sent.`, "error");
      return { action: "handled" as const };
    }
    const raise = `Raise the limit to ${idr(next)} and send`;
    const remove = "Send without a limit";
    const choice = await ctx.ui.select(`Session budget of ${idr(limit)} reached (spent ${idr(spent)})`, [raise, remove, "Don't send"]);
    if (choice === raise) limits.sessionIdr = next;
    else if (choice === remove) limits.sessionIdr = null;
    else {
      ctx.ui.setEditorText(event.text);
      return { action: "handled" as const };
    }
    warned = false;
    stopped = false;
    showStatus(ctx);
    return { action: "continue" as const };
  });

  pi.registerCommand("budget", {
    description: "Set a spending limit: /budget 5000, /budget turn 500, /budget off. Add --default to keep it",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const command = parseCommand(args);
      if (command.kind === "error") {
        ctx.ui.notify(command.message, "warning");
        return;
      }
      if (command.kind === "show") {
        const lines = [describe(limits, spent, turnSpent(), defaults)];
        if (unpriced) lines.push("Some responses had no price, so what is counted here is a minimum.");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const key = command.target === "session" ? "sessionIdr" : "turnIdr";
      limits[key] = command.amount;
      if (command.target === "session") {
        warned = false;
        stopped = false;
      } else {
        warnedTurn = false;
      }
      const name = command.target === "session" ? "Session budget" : "Prompt warning";
      const parts = [command.amount === null ? `${name} removed.` : `${name} set to ${idr(command.amount)}.`];
      if (command.remember) {
        defaults = { ...defaults, [key]: command.amount };
        try {
          writeDefaults(agentDir(), defaults);
          parts.push("It will apply to new sessions too.");
        } catch (err) {
          parts.push(`Could not save it for new sessions: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (command.target === "session" && command.amount !== null && spent >= command.amount) {
        parts.push(`${idr(spent)} is already spent, so the next message will ask what to do.`);
      }
      if (command.amount !== null && unpriced) {
        warnedUnpriced = true;
        parts.push(`Note: some responses so far had no price, and the budget can't count responses without a price (NusaGate's prices didn't load, or this model isn't in its catalog), so spending can pass the limit without a warning.`);
      }
      ctx.ui.notify(parts.join(" "), "info");
      showStatus(ctx);
    },
  });
}
