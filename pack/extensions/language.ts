/**
 * `/language`: switches NusaCode's own screens between English and Bahasa
 * Indonesia. It changes the TUI only, never what the agent replies in.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/home.ts";
import { messages, setLocale } from "../lib/i18n.ts";
import { findLanguage, LANGUAGES, readLanguage, writeLanguage } from "../lib/language.ts";

const t = messages(
  {
    description: "Switch NusaCode's screens between English and Bahasa Indonesia",
    unknown: 'Unknown language "{name}". Choose one of: {choices}.',
    pick: "Language",
    current: "{label} (current)",
    switched: "NusaCode is now in English. pi's own screens and command descriptions stay English until a restart.",
  },
  {
    description: "Ganti bahasa layar NusaCode: English atau Bahasa Indonesia",
    unknown: 'Bahasa "{name}" tidak dikenal. Pilih salah satu: {choices}.',
    pick: "Bahasa",
    current: "{label} (saat ini)",
    switched: "NusaCode sekarang memakai Bahasa Indonesia. Layar bawaan pi tetap English, dan deskripsi command ikut berubah setelah restart.",
  },
);

export default function language(pi: ExtensionAPI) {
  if (process.env.NUSACODE_SUBAGENT === "1") return;

  pi.registerCommand("language", {
    description: t("description"),
    getArgumentCompletions: (prefix) =>
      LANGUAGES.filter((l) => l.id.startsWith(prefix.trim().toLowerCase())).map((l) => ({ value: l.id, label: `${l.id}  ${l.label}` })),
    handler: async (args, ctx) => {
      const typed = args.trim();
      let picked = typed ? findLanguage(typed) : undefined;
      if (typed && !picked) {
        ctx.ui.notify(t("unknown", { name: typed, choices: LANGUAGES.map((l) => l.id).join(", ") }), "warning");
        return;
      }
      if (!picked) {
        const saved = readLanguage(agentDir());
        const labels = LANGUAGES.map((l) => (l.id === saved ? t("current", { label: l.label }) : l.label));
        const choice = await ctx.ui.select(t("pick"), labels);
        if (choice === undefined) return;
        picked = LANGUAGES[labels.indexOf(choice)];
      }
      if (!picked) return;
      writeLanguage(agentDir(), picked.id);
      setLocale(picked.id);
      ctx.ui.notify(t("switched"), "info");
    },
  });
}
