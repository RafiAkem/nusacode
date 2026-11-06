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
import { messages } from "../lib/i18n.ts";

const t = messages(
  {
    tooBig: "  too big to restore  {name}",
    created: "  created   {name}  (will be deleted)",
    modified: "  modified  {name}",
    aPrompt: "(a prompt)",
    changedOne: "{count} file changed. /undo puts it back.",
    changedMany: "{count} files changed. /undo puts them back.",
    description: "Put back the files the agent changed in its last prompt. `/undo list` shows what can be undone",
    usage: "Usage: /undo, /undo list",
    nothing: "Nothing to undo: the agent hasn't written or edited a file in this session.",
    nextUndo: 'Next undo · "{label}" · {ago}',
    beforeThat: 'Before that · "{label}" · {ago}',
    conflict: "  ! {name} was changed after the agent wrote it. Undoing replaces those changes.",
    notIncluded: "Changes made by shell commands and subagents aren't included.",
    confirm: 'Undo "{label}"?',
    restored: "restored {count}",
    deleted: "deleted {count}",
    skipped: "left {count} too big to restore",
    none: "nothing",
    undone: "Undone: {parts}.",
    couldNotRestore: "Could not restore:",
  },
  {
    tooBig: "  terlalu besar untuk dikembalikan  {name}",
    created: "  dibuat    {name}  (akan dihapus)",
    modified: "  diubah    {name}",
    aPrompt: "(sebuah prompt)",
    changedOne: "{count} file berubah. /undo mengembalikannya.",
    changedMany: "{count} file berubah. /undo mengembalikannya.",
    description: "Kembalikan file yang diubah agent di prompt terakhirnya. `/undo list` menampilkan apa saja yang bisa di-undo",
    usage: "Cara pakai: /undo, /undo list",
    nothing: "Tidak ada yang bisa di-undo: agent belum menulis atau mengedit file di sesi ini.",
    nextUndo: 'Undo berikutnya · "{label}" · {ago}',
    beforeThat: 'Sebelumnya · "{label}" · {ago}',
    conflict: "  ! {name} diubah lagi setelah agent menulisnya. Undo akan menimpa perubahan itu.",
    notIncluded: "Perubahan dari command shell dan subagent tidak ikut di-undo.",
    confirm: 'Undo "{label}"?',
    restored: "{count} dikembalikan",
    deleted: "{count} dihapus",
    skipped: "{count} dibiarkan karena terlalu besar untuk dikembalikan",
    none: "tidak ada",
    undone: "Selesai di-undo: {parts}.",
    couldNotRestore: "Gagal dikembalikan:",
  },
);

const FILE_TOOLS = new Set(["write", "edit"]);
const LABEL_LENGTH = 60;

/** A path as the user knows it: relative to where they are, unless that would climb out of it. */
function shown(path: string, cwd: string): string {
  const inside = relative(cwd, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

/** A prompt's label as the user sees it; an empty one was a prompt with no text to show. */
function labelShown(label: string): string {
  return label || t("aPrompt");
}

function describeChange(change: Change, cwd: string): string {
  const name = shown(change.path, cwd);
  if (change.unrestorable) return t("tooBig", { name });
  return t(change.kind === "created" ? "created" : "modified", { name });
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
    // An empty label is drawn as "(a prompt)" in the language in use; see labelShown.
    checkpoints.startTurn(label);
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
    ctx.ui.notify(t(count === 1 ? "changedOne" : "changedMany", { count }), "info");
  });

  pi.registerCommand("undo", {
    description: t("description"),
    handler: async (args, ctx) => {
      const word = args.trim().toLowerCase();
      if (word !== "" && word !== "list") {
        ctx.ui.notify(t("usage"), "warning");
        return;
      }
      if (word === "list") {
        const history = checkpoints.history();
        if (history.length === 0) {
          ctx.ui.notify(t("nothing"), "info");
          return;
        }
        const now = new Date();
        const lines = history.flatMap((entry, i) => [
          t(i === 0 ? "nextUndo" : "beforeThat", { label: labelShown(entry.label), ago: timeAgo(entry.at, now) }),
          ...entry.changes.map((change) => describeChange(change, ctx.cwd)),
        ]);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const latest = checkpoints.latest();
      if (!latest) {
        ctx.ui.notify(t("nothing"), "info");
        return;
      }
      const lines = latest.changes.map((change) => describeChange(change, ctx.cwd));
      const conflicts = latest.changes.filter((change) => change.conflict && !change.unrestorable);
      for (const change of conflicts) lines.push(t("conflict", { name: shown(change.path, ctx.cwd) }));
      lines.push("", t("notIncluded"));
      const ok = await ctx.ui.confirm(t("confirm", { label: labelShown(latest.label) }), lines.join("\n"));
      if (!ok) return;

      const result = checkpoints.undoLatest();
      if (!result) return;
      const parts: string[] = [];
      if (result.restored.length) parts.push(t("restored", { count: result.restored.length }));
      if (result.deleted.length) parts.push(t("deleted", { count: result.deleted.length }));
      if (result.skipped.length) parts.push(t("skipped", { count: result.skipped.length }));
      const failed = result.failed.map((item) => `${shown(item.path, ctx.cwd)}: ${item.error}`);
      ctx.ui.notify(
        `${t("undone", { parts: parts.join(", ") || t("none") })}${failed.length ? `\n${t("couldNotRestore")}\n  ${failed.join("\n  ")}` : ""}`,
        failed.length ? "warning" : "info",
      );

      const names = [...result.restored, ...result.deleted].map((path) => shown(path, ctx.cwd));
      if (names.length) {
        pi.sendMessage(
          {
            customType: "nusacode-undo",
            content: `The user undid your last file changes ("${latest.label || "(a prompt)"}"). These files are back to how they were before: ${names.join(", ")}. Read them again before editing, and don't assume your earlier edits are still there.`,
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
      }
    },
  });
}
