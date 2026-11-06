/**
 * Reply language: adds one line to the system prompt so the agent answers in the
 * language picked in `/setup` or with `/language`. With nothing picked, or "Match my
 * messages", the system prompt is left alone.
 *
 * The line only changes when the language does, so the cached prompt prefix holds.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/home.ts";
import { findLanguage, LANGUAGES, readLanguage, withLanguage, writeLanguage } from "../lib/language.ts";

export default function language(pi: ExtensionAPI) {
  if (process.env.NUSACODE_SUBAGENT === "1") return;

  pi.on("before_agent_start", (event) => {
    const systemPrompt = withLanguage(event.systemPrompt, readLanguage(agentDir()));
    if (systemPrompt !== event.systemPrompt) return { systemPrompt };
  });

  pi.registerCommand("language", {
    description: "Choose the language the agent replies in: English, Bahasa Indonesia, or match your messages",
    getArgumentCompletions: (prefix) =>
      LANGUAGES.filter((l) => l.id.startsWith(prefix.trim().toLowerCase())).map((l) => ({ value: l.id, label: `${l.id}  ${l.label}` })),
    handler: async (args, ctx) => {
      let picked = args.trim() ? findLanguage(args) : undefined;
      if (args.trim() && !picked) {
        ctx.ui.notify(`Unknown language "${args.trim()}". Choose one of: ${LANGUAGES.map((l) => l.id).join(", ")}.`, "warning");
        return;
      }
      if (!picked) {
        const current = readLanguage(agentDir());
        const labels = LANGUAGES.map((l) => (l.id === current ? `${l.label} (current)` : l.label));
        const choice = await ctx.ui.select("Reply language", labels);
        if (choice === undefined) return;
        picked = LANGUAGES[labels.indexOf(choice)];
      }
      if (!picked) return;
      writeLanguage(agentDir(), picked.id);
      ctx.ui.notify(
        picked.instruction ? `The agent now replies in ${picked.label}.` : "The agent now replies in the language you write in.",
        "info",
      );
    },
  });
}
