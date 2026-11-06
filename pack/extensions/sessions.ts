/**
 * /sessions: switch to another session in one step.
 *
 * pi's /resume opens a full browser. This is the quick version: a pick list of recent
 * sessions with their size and age, an optional filter (`/sessions auth bug`), `all` to
 * search every folder, and a "New session" entry at the top.
 */
import type { ExtensionAPI, SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionLabel, timeAgo } from "./brand.ts";
import { messages } from "../lib/i18n.ts";

const t = messages(
  {
    description: "Switch session quickly. Add words to filter, or `all` to search every folder",
    listFailed: "Could not list sessions: {error}",
    noMatch: 'No other sessions match "{query}".',
    noneHere: "No other sessions here yet.",
    title: "Switch session",
    titleAll: "Switch session (all folders)",
    titleMatching: 'Switch session matching "{query}"',
    titleMatchingAll: 'Switch session matching "{query}" (all folders)',
    newSession: "+ New session",
    messageOne: "{count} msg",
    messageMany: "{count} msgs",
  },
  {
    description: "Ganti sesi dengan cepat. Tambahkan kata untuk menyaring, atau `all` untuk cari di semua folder",
    listFailed: "Tidak bisa memuat daftar sesi: {error}",
    noMatch: 'Tidak ada sesi lain yang cocok dengan "{query}".',
    noneHere: "Belum ada sesi lain di sini.",
    title: "Ganti sesi",
    titleAll: "Ganti sesi (semua folder)",
    titleMatching: 'Ganti sesi yang cocok dengan "{query}"',
    titleMatchingAll: 'Ganti sesi yang cocok dengan "{query}" (semua folder)',
    newSession: "+ Sesi baru",
    messageOne: "{count} pesan",
    messageMany: "{count} pesan",
  },
);

const MAX_CHOICES = 30;
const LABEL_WIDTH = 60;

type Listed = Pick<SessionInfo, "path" | "cwd" | "name" | "firstMessage" | "messageCount" | "modified" | "allMessagesText">;

export type Parsed = { all: boolean; query: string };

/** `/sessions all auth` searches every folder for "auth". */
export function parseArgs(args: string): Parsed {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const all = words[0]?.toLowerCase() === "all";
  return { all, query: (all ? words.slice(1) : words).join(" ").toLowerCase() };
}

export function matches(session: Listed, query: string): boolean {
  if (!query) return true;
  const haystack = `${session.name ?? ""} ${session.firstMessage} ${session.allMessagesText}`.toLowerCase();
  return query.split(" ").every((word) => haystack.includes(word));
}

function clip(text: string): string {
  return text.length > LABEL_WIDTH ? `${text.slice(0, LABEL_WIDTH - 1)}…` : text;
}

function folderOf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** One pick-list row: `1. fix the meter bug · 12 msgs · 3m ago`. */
export function choiceLabel(index: number, session: Listed, now: Date, showFolder: boolean): string {
  const parts = [
    clip(sessionLabel(session)),
    t(session.messageCount === 1 ? "messageOne" : "messageMany", { count: session.messageCount }),
    timeAgo(session.modified, now),
  ];
  if (showFolder && session.cwd) parts.push(folderOf(session.cwd));
  return `${index}. ${parts.join(" · ")}`;
}

/** Newest first, minus the open session, filtered and capped. */
export function pickable(sessions: Listed[], current: string | undefined, query: string): Listed[] {
  return sessions
    .filter((session) => session.path !== current && matches(session, query))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, MAX_CHOICES);
}

export default function sessions(pi: ExtensionAPI) {
  pi.registerCommand("sessions", {
    description: t("description"),
    handler: async (args, ctx) => {
      const { all, query } = parseArgs(args);
      let found: Listed[];
      try {
        found = all ? await SessionManager.listAll() : await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
      } catch (err) {
        ctx.ui.notify(t("listFailed", { error: err instanceof Error ? err.message : String(err) }), "error");
        return;
      }
      const options = pickable(found, ctx.sessionManager.getSessionFile(), query);
      if (options.length === 0) {
        ctx.ui.notify(query ? t("noMatch", { query }) : t("noneHere"), "info");
        return;
      }
      const now = new Date();
      const labels = options.map((session, i) => choiceLabel(i + 1, session, now, all));
      const titleKey = query ? (all ? "titleMatchingAll" : "titleMatching") : all ? "titleAll" : "title";
      const newSession = t("newSession");
      const picked = await ctx.ui.select(t(titleKey, { query }), [newSession, ...labels]);
      if (!picked) return;
      if (picked === newSession) {
        await ctx.newSession();
        return;
      }
      const target = options[labels.indexOf(picked)];
      if (target) await ctx.switchSession(target.path);
    },
  });
}
