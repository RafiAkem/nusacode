import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idr, parseIdr } from "./money.ts";
import { messages } from "./i18n.ts";

const t = messages(
  {
    usage:
      "Usage: /budget <amount|off> · /budget turn <amount|off> · add --default to keep it for new sessions\n" +
      "Amounts: 5000, 5.000, Rp 5.000, 5k, 1.5m",
    notAnAmount: "\"{value}\" is not an amount. {usage}",
    session: "Session",
    prompt: "Prompt",
    noLimit: "no limit",
    spentOf: "{used} of {limit} · {left} left{note}",
    defaultNote: " · default",
    change: "Change it with /budget <amount|off> or /budget turn <amount|off>.",
  },
  {
    usage:
      "Cara pakai: /budget <amount|off> · /budget turn <amount|off> · tambahkan --default supaya berlaku juga di sesi baru\n" +
      "Jumlah: 5000, 5.000, Rp 5.000, 5k, 1.5m",
    notAnAmount: "\"{value}\" bukan jumlah yang valid. {usage}",
    session: "Sesi",
    prompt: "Prompt",
    noLimit: "tanpa batas",
    spentOf: "{used} dari {limit} · sisa {left}{note}",
    defaultNote: " · default",
    change: "Ubah dengan /budget <amount|off> atau /budget turn <amount|off>.",
  },
);

/** Spending limits in whole rupiah. `null` means no limit. */
export type Limits = { sessionIdr: number | null; turnIdr: number | null };

export const BUDGET_FILE = "budget.json";
/** The warning comes when this much of a limit is spent. */
export const WARN_FRACTION = 0.8;

export type Level = "ok" | "warn" | "over";

export function levelOf(spent: number, limit: number | null): Level {
  if (limit === null) return "ok";
  if (spent >= limit) return "over";
  return spent >= limit * WARN_FRACTION ? "warn" : "ok";
}

const asLimit = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

/** Limits that apply to every new session. A missing or broken file means no limits. */
export function readDefaults(dir: string): Limits {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, BUDGET_FILE), "utf8"));
    const entry = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return { sessionIdr: asLimit(entry.session), turnIdr: asLimit(entry.turn) };
  } catch {
    return { sessionIdr: null, turnIdr: null };
  }
}

export function writeDefaults(dir: string, limits: Limits): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, BUDGET_FILE);
  const temp = `${target}.tmp`;
  const body: Record<string, number> = {};
  if (limits.sessionIdr !== null) body.session = limits.sessionIdr;
  if (limits.turnIdr !== null) body.turn = limits.turnIdr;
  writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(temp, target);
}

export type Command =
  | { kind: "show" }
  | { kind: "set"; target: "session" | "turn"; amount: number | null; remember: boolean }
  | { kind: "error"; message: string };

/** How to use `/budget`, in the language in use. */
export function usage(): string {
  return t("usage");
}

/** `/budget`, `/budget 5000`, `/budget turn 500 --default`, `/budget off`. */
export function parseCommand(args: string): Command {
  let words = args.trim().split(/\s+/).filter(Boolean);
  const remember = words.includes("--default");
  words = words.filter((word) => word !== "--default");
  if (words.length === 0) return remember ? { kind: "error", message: usage() } : { kind: "show" };
  const target = words[0].toLowerCase() === "turn" ? "turn" : "session";
  const value = (target === "turn" ? words.slice(1) : words).join(" ");
  if (value.toLowerCase() === "off") return { kind: "set", target, amount: null, remember };
  const amount = parseIdr(value);
  if (amount === null) return { kind: "error", message: value ? t("notAnAmount", { value, usage: usage() }) : usage() };
  return { kind: "set", target, amount, remember };
}

/** Where the limit is next set after it was reached: what was spent plus the old limit, to the next Rp 100. */
export function raisedLimit(spent: number, limit: number): number {
  return Math.ceil((spent + limit) / 100) * 100;
}

/** The `/budget` report. */
export function describe(limits: Limits, spent: number, turnSpent: number, defaults: Limits): string {
  const line = (label: string, used: number, limit: number | null, kept: number | null) => {
    if (limit === null) return `${label.padEnd(8)}${t("noLimit")}`;
    const left = Math.max(0, limit - used);
    const note = kept === limit ? t("defaultNote") : "";
    return `${label.padEnd(8)}${t("spentOf", { used: idr(used), limit: idr(limit), left: idr(left), note })}`;
  };
  return [
    line(t("session"), spent, limits.sessionIdr, defaults.sessionIdr),
    line(t("prompt"), turnSpent, limits.turnIdr, defaults.turnIdr),
    t("change"),
  ].join("\n");
}
