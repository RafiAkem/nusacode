/**
 * /undo: put back the files the agent changed in its last prompt.
 *
 *   /undo         restore what the newest prompt changed (asks first), then the one before it next time
 *   /undo list    show which prompts changed which files
 *
 * The bookkeeping is in lib/checkpoints.ts. This file feeds it from the agent's `write` and `edit`
 * tools, and tells the model afterwards, so it doesn't carry on as if its changes were still there.
 * Changes made by shell commands and by subagents are outside its sight and are not undone.
 */
import { relative, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Checkpoints, resolveToolPath, type Change } from "../lib/checkpoints.ts";
import { timeAgo } from "./brand.ts";

const FILE_TOOLS = new Set(["write", "edit"]);
const LABEL_LENGTH = 60;

/** A path as the user knows it: relative to where they are, unless that would climb out of it. */
function shown(path: string, cwd: string): string {
  const inside = relative(cwd, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

function describeChange(change: Change, cwd: string): string {
  const name = shown(change.path, cwd);
  if (change.unrestorable) return `  too big to restore  ${name}`;
  return change.kind === "created" ? `  created   ${name}  (will be deleted)` : `  modified  ${name}`;
}

export default function undo(pi: ExtensionAPI) {
  let checkpoints = new Checkpoints();
  let label = "";
  let told = false;

  pi.on("session_start", () => {
    checkpoints = new Checkpoints();
    label = "";
    told = false;
  });

  // The prompt's own text, for the list. `input` runs before `agent_start`.
  pi.on("input", (event) => {
    label = event.text.replace(/\s+/g, " ").trim().slice(0, LABEL_LENGTH);
    return { action: "continue" as const };
  });

  pi.on("agent_start", () => {
    checkpoints.startTurn(label || "(a prompt)");
  });

  pi.on("tool_call", (event, ctx) => {
    if (!FILE_TOOLS.has(event.toolName)) return undefined;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path === "string") checkpoints.before(resolveToolPath(path, ctx.cwd));
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    if (!FILE_TOOLS.has(event.toolName)) return undefined;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path === "string") checkpoints.after(resolveToolPath(path, ctx.cwd));
    return undefined;
  });

  pi.on("agent_end", (_event, ctx) => {
    if (told) return;
    const latest = checkpoints.latest();
    if (!latest) return;
    told = true;
    const count = latest.changes.length;
    ctx.ui.notify(`${count} file${count === 1 ? "" : "s"} changed. /undo puts ${count === 1 ? "it" : "them"} back.`, "info");
  });

  pi.registerCommand("undo", {
    description: "Put back the files the agent changed in its last prompt. `/undo list` shows what can be undone",
    handler: async (args, ctx) => {
      const word = args.trim().toLowerCase();
      if (word !== "" && word !== "list") {
        ctx.ui.notify("Usage: /undo, /undo list", "warning");
        return;
      }
      if (word === "list") {
        const history = checkpoints.history();
        if (history.length === 0) {
          ctx.ui.notify("Nothing to undo: the agent hasn't written or edited a file in this session.", "info");
          return;
        }
        const now = new Date();
        const lines = history.flatMap((entry, i) => [
          `${i === 0 ? "Next undo" : "Before that"} · "${entry.label}" · ${timeAgo(entry.at, now)}`,
          ...entry.changes.map((change) => describeChange(change, ctx.cwd)),
        ]);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const latest = checkpoints.latest();
      if (!latest) {
        ctx.ui.notify("Nothing to undo: the agent hasn't written or edited a file in this session.", "info");
        return;
      }
      const lines = latest.changes.map((change) => describeChange(change, ctx.cwd));
      const conflicts = latest.changes.filter((change) => change.conflict && !change.unrestorable);
      for (const change of conflicts) lines.push(`  ! ${shown(change.path, ctx.cwd)} was changed after the agent wrote it. Undoing replaces those changes.`);
      lines.push("", "Changes made by shell commands and subagents aren't included.");
      const ok = await ctx.ui.confirm(`Undo "${latest.label}"?`, lines.join("\n"));
      if (!ok) return;

      const result = checkpoints.undoLatest();
      if (!result) return;
      const parts: string[] = [];
      if (result.restored.length) parts.push(`restored ${result.restored.length}`);
      if (result.deleted.length) parts.push(`deleted ${result.deleted.length}`);
      if (result.skipped.length) parts.push(`left ${result.skipped.length} too big to restore`);
      const failed = result.failed.map((item) => `${shown(item.path, ctx.cwd)}: ${item.error}`);
      ctx.ui.notify(
        `Undone: ${parts.join(", ") || "nothing"}.${failed.length ? `\nCould not restore:\n  ${failed.join("\n  ")}` : ""}`,
        failed.length ? "warning" : "info",
      );

      const names = [...result.restored, ...result.deleted].map((path) => shown(path, ctx.cwd));
      if (names.length) {
        pi.sendMessage(
          {
            customType: "nusacode-undo",
            content: `The user undid your last file changes ("${latest.label}"). These files are back to how they were before: ${names.join(", ")}. Read them again before editing, and don't assume your earlier edits are still there.`,
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
      }
    },
  });
}
