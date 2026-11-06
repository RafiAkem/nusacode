/**
 * /plan: let the agent look but not touch, or touch only what you approve.
 *
 *   /plan         toggle plan mode (read and search only)
 *   /plan ask     reading is free; every change is shown to you first
 *   /plan off     back to normal
 *   alt+m         the same toggle, from the keyboard
 *   --plan        start a session in plan mode
 *
 * The rules live in lib/plan-mode.ts. This file applies them to each tool call, tells the
 * model when the mode changes (as a message at the end of the conversation, because changing
 * the system prompt would throw away the provider's prompt cache), and keeps the status bar honest.
 *
 * It guards the main agent only. A `task` subagent is limited to the read-only agents instead,
 * since a child process doesn't load this extension.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { judge, modeNotice, parseMode, statusText, type Mode } from "../lib/plan-mode.ts";

const STATUS_KEY = "nusa-mode";
const ALLOW = "Allow";
const ALLOW_ALL = "Allow, and stop asking";
const DENY = "Deny";

export default function plan(pi: ExtensionAPI) {
  let mode: Mode = "off";

  pi.registerFlag("plan", { description: "Start in plan mode: the agent can read but not change anything", type: "boolean" });

  function setMode(next: Mode, ctx: ExtensionContext, tell: boolean): void {
    mode = next;
    ctx.ui.setStatus(STATUS_KEY, statusText(mode));
    if (tell) pi.sendMessage({ customType: "nusacode-mode", content: modeNotice(mode), display: false }, { deliverAs: "nextTurn" });
  }

  const describe = (value: Mode) =>
    value === "plan"
      ? "Plan mode is on: the agent can read and search, but not change anything. /plan off to leave."
      : value === "ask"
        ? "Ask mode is on: you approve every change. /plan off to leave."
        : "Plan mode is off.";

  pi.on("session_start", (_event, ctx) => {
    setMode(pi.getFlag("plan") === true ? "plan" : "off", ctx, false);
  });

  pi.on("tool_call", async (event, ctx) => {
    const verdict = judge(mode, event.toolName, event.input as Record<string, unknown>);
    if (verdict.kind === "allow") return undefined;
    if (verdict.kind === "block") return { block: true, reason: verdict.reason };
    if (!ctx.hasUI) {
      return { block: true, reason: `${verdict.summary} needs the user's approval, and there is no screen to ask on.` };
    }
    const answer = await ctx.ui.select(`Allow this?\n${verdict.summary}`, [ALLOW, ALLOW_ALL, DENY]);
    if (answer === ALLOW) return undefined;
    if (answer === ALLOW_ALL) {
      setMode("off", ctx, true);
      ctx.ui.notify("Ask mode is off. The agent can change files and run commands again.", "info");
      return undefined;
    }
    return { block: true, reason: `The user declined: ${verdict.summary}. Ask what they would like instead.` };
  });

  pi.registerCommand("plan", {
    description: "Plan mode: /plan toggles read-only, /plan ask approves each change, /plan off leaves it",
    handler: async (args, ctx) => {
      const next = parseMode(args, mode);
      if (next === null) {
        ctx.ui.notify("Usage: /plan, /plan ask, /plan off, /plan status", "warning");
        return;
      }
      if (next === "status") {
        ctx.ui.notify(describe(mode), "info");
        return;
      }
      if (next !== mode) setMode(next, ctx, true);
      ctx.ui.notify(describe(next), "info");
    },
  });

  pi.registerShortcut("alt+m", {
    description: "Toggle plan mode",
    handler: (ctx) => {
      const next: Mode = mode === "off" ? "plan" : "off";
      setMode(next, ctx, true);
      ctx.ui.notify(describe(next), "info");
    },
  });
}
