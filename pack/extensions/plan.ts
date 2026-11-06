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
 * It guards the main agent only. A child process doesn't load this extension, so a `task` subagent
 * is only allowed when its definition file (read fresh each time, since it can be edited) gives it
 * nothing but read-only tools.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { judge, modeNotice, parseMode, statusText, summaryShown, type AgentTools, type Mode } from "../lib/plan-mode.ts";
import { messages } from "../lib/i18n.ts";
import { loadAgents } from "./subagents.ts";

const t = messages(
  {
    allow: "Allow",
    allowAll: "Allow, and stop asking",
    deny: "Deny",
    flag: "Start in plan mode: the agent can read but not change anything",
    planOn: "Plan mode is on: the agent can read and search, but not change anything. /plan off to leave.",
    askOn: "Ask mode is on: you approve every change. /plan off to leave.",
    off: "Plan mode is off.",
    allowThis: "Allow this?\n{summary}",
    askOff: "Ask mode is off. The agent can change files and run commands again.",
    description: "Plan mode: /plan toggles read-only, /plan ask approves each change, /plan off leaves it",
    usage: "Usage: /plan, /plan ask, /plan off, /plan status",
    shortcut: "Toggle plan mode",
  },
  {
    allow: "Izinkan",
    allowAll: "Izinkan, dan jangan tanya lagi",
    deny: "Tolak",
    flag: "Mulai di mode plan: agent bisa membaca tapi tidak bisa mengubah apa pun",
    planOn: "Mode plan aktif: agent bisa membaca dan mencari, tapi tidak bisa mengubah apa pun. /plan off untuk keluar.",
    askOn: "Mode ask aktif: agent tanya dulu sebelum tiap perubahan, dan kamu yang menyetujui. /plan off untuk keluar.",
    off: "Mode plan nonaktif.",
    allowThis: "Izinkan ini?\n{summary}",
    askOff: "Mode ask nonaktif. Agent bisa mengubah file dan menjalankan command lagi.",
    description: "Mode plan: /plan untuk mode hanya baca, /plan ask untuk tanya dulu sebelum tiap perubahan, /plan off untuk keluar",
    usage: "Cara pakai: /plan, /plan ask, /plan off, /plan status",
    shortcut: "Aktifkan atau nonaktifkan mode plan",
  },
);

const STATUS_KEY = "nusa-mode";

export default function plan(pi: ExtensionAPI) {
  let mode: Mode = "off";

  pi.registerFlag("plan", { description: t("flag"), type: "boolean" });

  function setMode(next: Mode, ctx: ExtensionContext, tell: boolean): void {
    mode = next;
    ctx.ui.setStatus(STATUS_KEY, statusText(mode));
    if (tell) pi.sendMessage({ customType: "nusacode-mode", content: modeNotice(mode), display: false }, { deliverAs: "nextTurn" });
  }

  const describe = (value: Mode) => t(value === "plan" ? "planOn" : value === "ask" ? "askOn" : "off");

  pi.on("session_start", (_event, ctx) => {
    setMode(pi.getFlag("plan") === true ? "plan" : "off", ctx, false);
  });

  pi.on("tool_call", async (event, ctx) => {
    const agentTools: AgentTools = (name) => loadAgents().get(name)?.tools.split(",").filter(Boolean);
    const verdict = judge(mode, event.toolName, event.input as Record<string, unknown>, agentTools);
    if (verdict.kind === "allow") return undefined;
    if (verdict.kind === "block") return { block: true, reason: verdict.reason };
    if (!ctx.hasUI) {
      return { block: true, reason: `${verdict.summary} needs the user's approval, and there is no screen to ask on.` };
    }
    const ALLOW = t("allow");
    const ALLOW_ALL = t("allowAll");
    const shown = summaryShown(event.toolName, event.input as Record<string, unknown>);
    const answer = await ctx.ui.select(t("allowThis", { summary: shown }), [ALLOW, ALLOW_ALL, t("deny")]);
    if (answer === ALLOW) return undefined;
    if (answer === ALLOW_ALL) {
      setMode("off", ctx, true);
      ctx.ui.notify(t("askOff"), "info");
      return undefined;
    }
    return { block: true, reason: `The user declined: ${verdict.summary}. Ask what they would like instead.` };
  });

  pi.registerCommand("plan", {
    description: t("description"),
    handler: async (args, ctx) => {
      const next = parseMode(args, mode);
      if (next === null) {
        ctx.ui.notify(t("usage"), "warning");
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
    description: t("shortcut"),
    handler: (ctx) => {
      const next: Mode = mode === "off" ? "plan" : "off";
      setMode(next, ctx, true);
      ctx.ui.notify(describe(next), "info");
    },
  });
}
