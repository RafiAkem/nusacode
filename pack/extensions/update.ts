/**
 * `/update`: installs the newest NusaCode without leaving for a terminal.
 *
 * NusaCode can't replace its own files while it runs (Windows locks pi's native module), so this
 * leaves a request for the launcher and quits. The launcher updates once pi has exited, then
 * reopens this session with `--continue`. See bin/self-update.js.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/home.ts";
import { messages } from "../lib/i18n.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

interface SelfUpdate {
  installMethod(root: string): { kind: "checkout" | "npx" | "global"; display?: string };
  isNewer(current: string, latest: string): boolean;
  latestVersion(): Promise<string | null>;
  requestUpdate(home: string): void;
}

const t = messages(
  {
    description: "Update NusaCode to the newest version",
    checking: "Checking npm for a newer NusaCode…",
    current: "NusaCode is up to date (v{version}).",
    offline: "Couldn't reach npm to check for a newer version. Try again later.",
    checkout: "NusaCode is running from a git checkout. To update it, run git pull && npm install in the repo.",
    npx: "NusaCode is running through npx. Start it with npx nusacode@latest to get the newest version.",
    noLauncher: "Quit NusaCode and run: nusacode update",
    confirm: "Update to v{latest}?",
    confirmBody: "NusaCode closes, updates from v{current}, and reopens this session.",
  },
  {
    description: "Update NusaCode ke versi terbaru",
    checking: "Mengecek versi NusaCode terbaru di npm…",
    current: "NusaCode sudah versi terbaru (v{version}).",
    offline: "Tidak bisa menghubungi npm untuk mengecek versi baru. Coba lagi nanti.",
    checkout: "NusaCode berjalan dari git checkout. Untuk update, jalankan git pull && npm install di repo.",
    npx: "NusaCode berjalan lewat npx. Jalankan npx nusacode@latest untuk versi terbaru.",
    noLauncher: "Keluar dari NusaCode lalu jalankan: nusacode update",
    confirm: "Update ke v{latest}?",
    confirmBody: "NusaCode akan ditutup, di-update dari v{current}, lalu sesi ini dibuka lagi.",
  },
);

function installedVersion(): string {
  try {
    return String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  } catch {
    return "0.0.0";
  }
}

export default function update(pi: ExtensionAPI) {
  if (process.env.NUSACODE_SUBAGENT === "1") return;

  pi.registerCommand("update", {
    description: t("description"),
    handler: async (_args, ctx) => {
      const self = require("../../bin/self-update.js") as SelfUpdate;
      const method = self.installMethod(ROOT);
      if (method.kind === "checkout" || method.kind === "npx") {
        ctx.ui.notify(t(method.kind), "info");
        return;
      }
      ctx.ui.notify(t("checking"), "info");
      const current = installedVersion();
      const latest = await self.latestVersion();
      if (!latest) {
        ctx.ui.notify(t("offline"), "warning");
        return;
      }
      if (!self.isNewer(current, latest)) {
        ctx.ui.notify(t("current", { version: current }), "info");
        return;
      }
      // Only the launcher acts on the request; pi started some other way would just quit.
      if (process.env.NUSACODE_LAUNCHER !== "1") {
        ctx.ui.notify(t("noLauncher"), "info");
        return;
      }
      if (!(await ctx.ui.confirm(t("confirm", { latest }), t("confirmBody", { current })))) return;
      self.requestUpdate(agentDir());
      ctx.shutdown();
    },
  });
}
