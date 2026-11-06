import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idr } from "./money.ts";

/**
 * A running record of spending, one line of JSON per response, kept in the NusaCode home.
 *
 * It is what lets `/usage` answer "what did I spend today, and on which model?" across
 * sessions. Costs are stored as they were charged then, so later price changes don't
 * rewrite history. Only counts and the model name are kept, never any text.
 */
export type LogRecord = {
  /** When the response finished, as an ISO timestamp. */
  t: string;
  session?: string;
  /** `provider/model`. */
  model: string;
  /** Whole rupiah; 0 for a model with no price. */
  cost: number;
  /** Prompt tokens at the full input price. */
  fresh: number;
  /** Prompt tokens read from the cache. */
  cached: number;
  output: number;
  /** The response came from a subagent. */
  sub?: true;
  /** The model had no price, so `cost` says nothing. */
  unpriced?: true;
};

export const LOG_FILE = "usage.jsonl";
/** Records older than this are dropped when the file gets big. */
const KEEP_DAYS = 400;
const PRUNE_ABOVE_BYTES = 2_000_000;
const DAY_MS = 86_400_000;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseRecord(line: string): LogRecord | null {
  try {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (typeof row.t !== "string" || Number.isNaN(Date.parse(row.t)) || typeof row.model !== "string") return null;
    if (!isCount(row.cost) || !isCount(row.fresh) || !isCount(row.cached) || !isCount(row.output)) return null;
    return {
      t: row.t,
      ...(typeof row.session === "string" ? { session: row.session } : {}),
      model: row.model,
      cost: row.cost,
      fresh: row.fresh,
      cached: row.cached,
      output: row.output,
      ...(row.sub === true ? { sub: true as const } : {}),
      ...(row.unpriced === true ? { unpriced: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/** Every readable record, oldest first. A missing file is an empty history; broken lines are skipped. */
export function readLog(dir: string): LogRecord[] {
  let text: string;
  try {
    text = readFileSync(join(dir, LOG_FILE), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    const record = line.trim() ? parseRecord(line) : null;
    return record ? [record] : [];
  });
}

export function appendRecord(dir: string, record: LogRecord): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, LOG_FILE), `${JSON.stringify(record)}\n`);
}

/** Drops old records once the file is large, so the log never grows without bound. */
export function pruneLog(dir: string, now: Date): void {
  const file = join(dir, LOG_FILE);
  try {
    if (statSync(file).size <= PRUNE_ABOVE_BYTES) return;
  } catch {
    return;
  }
  const cutoff = now.getTime() - KEEP_DAYS * DAY_MS;
  const kept = readLog(dir).filter((record) => Date.parse(record.t) >= cutoff);
  const temp = `${file}.tmp`;
  writeFileSync(temp, kept.map((record) => `${JSON.stringify(record)}\n`).join(""));
  renameSync(temp, file);
}

export type Period = "today" | "week" | "month" | "all";

export function parsePeriod(args: string): Period | null {
  const word = args.trim().toLowerCase();
  if (word === "") return "month";
  return (["today", "week", "month", "all"] as const).find((period) => period === word) ?? null;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Where a period begins, in local time; `null` means no start. The week is the last 7 days, today included. */
export function periodStart(period: Period, now: Date): Date | null {
  const today = startOfDay(now);
  if (period === "today") return today;
  if (period === "week") return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  return null;
}

export type Total = { cost: number; requests: number; fresh: number; cached: number; output: number; unpriced: number };

const emptyTotal = (): Total => ({ cost: 0, requests: 0, fresh: 0, cached: 0, output: 0, unpriced: 0 });

function add(total: Total, record: LogRecord): void {
  total.cost += record.cost;
  total.requests += 1;
  total.fresh += record.fresh;
  total.cached += record.cached;
  total.output += record.output;
  if (record.unpriced) total.unpriced += 1;
}

export function within(records: LogRecord[], from: Date | null): LogRecord[] {
  if (from === null) return records;
  const start = from.getTime();
  return records.filter((record) => Date.parse(record.t) >= start);
}

export function totalOf(records: LogRecord[]): Total {
  const total = emptyTotal();
  for (const record of records) add(total, record);
  return total;
}

/** Totals per model, the most expensive first. */
export function byModel(records: LogRecord[]): [string, Total][] {
  const totals = new Map<string, Total>();
  for (const record of records) {
    const total = totals.get(record.model) ?? emptyTotal();
    add(total, record);
    totals.set(record.model, total);
  }
  return [...totals].sort((a, b) => b[1].cost - a[1].cost || b[1].requests - a[1].requests);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Cost per local day for the last `days` days, oldest first, with empty days included. */
export function dailyCosts(records: LogRecord[], now: Date, days = 7): { label: string; cost: number }[] {
  const today = startOfDay(now);
  const rows = Array.from({ length: days }, (_, i) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i));
    return { day, label: `${WEEKDAYS[day.getDay()]} ${String(day.getDate()).padStart(2, "0")}`, cost: 0 };
  });
  for (const record of records) {
    const at = new Date(record.t);
    const row = rows.find(({ day }) => day.getTime() === startOfDay(at).getTime());
    if (row) row.cost += record.cost;
  }
  return rows.map(({ label, cost }) => ({ label, cost }));
}

/** Today's and this month's totals as label and value pairs, for the /usage report. Empty before anything is recorded. */
export function periodRows(records: LogRecord[], now: Date): [string, string][] {
  if (records.length === 0) return [];
  const row = (label: string, from: Date): [string, string] => {
    const total = totalOf(within(records, from));
    return [label, `${idr(total.cost)} · ${plural(total.requests, "request")}`];
  };
  return [row("Today", periodStart("today", now) as Date), row("This month", periodStart("month", now) as Date)];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function cachePercent(total: Total): string {
  const prompt = total.fresh + total.cached;
  return prompt > 0 ? `${Math.round((total.cached / prompt) * 100)}%` : "0%";
}

function bars(rows: { label: string; cost: number }[], width = 14): string[] {
  const top = Math.max(0, ...rows.map((row) => row.cost));
  return rows.map(({ label, cost }) => {
    const filled = top > 0 ? Math.round((cost / top) * width) : 0;
    return `${label}  ${"█".repeat(filled)}${"░".repeat(width - filled)} ${idr(cost)}`;
  });
}

const TITLES: Record<Period, string> = { today: "today", week: "the last 7 days", month: "this month", all: "all time" };

/** The `/usage history` report. */
export function historyReport(records: LogRecord[], period: Period, now: Date): string {
  const header = "NusaCode · usage history";
  const lines = [header, "─".repeat(header.length + 8)];
  if (records.length === 0) {
    lines.push("Nothing recorded yet. Spending is saved here as you use NusaCode.");
    return lines.join("\n");
  }
  const summaryRow = (label: string, from: Date | null) => {
    const total = totalOf(within(records, from));
    return `${label.padEnd(13)}${idr(total.cost)} · ${plural(total.requests, "request")}`;
  };
  lines.push(summaryRow("Today", periodStart("today", now)));
  lines.push(summaryRow("Last 7 days", periodStart("week", now)));
  lines.push(summaryRow("This month", periodStart("month", now)));
  lines.push(summaryRow("All time", null));
  lines.push("", "Per day", ...bars(dailyCosts(records, now)));

  const scoped = within(records, periodStart(period, now));
  lines.push("", `By model, ${TITLES[period]}`);
  const models = byModel(scoped);
  if (models.length === 0) lines.push("No usage in this period.");
  const nameWidth = Math.max(0, ...models.map(([name]) => name.length));
  for (const [name, total] of models) {
    const average = total.requests > 0 ? idr(total.cost / total.requests) : idr(0);
    lines.push(`${name.padEnd(nameWidth)}  ${idr(total.cost)} · ${plural(total.requests, "request")} · ${average}/request · cache ${cachePercent(total)}`);
  }
  const unpriced = totalOf(scoped).unpriced;
  if (unpriced > 0) lines.push("", `${plural(unpriced, "response")} had no price, so their cost is not counted.`);
  lines.push("", "Other periods: /usage history today | week | month | all");
  return lines.join("\n");
}
