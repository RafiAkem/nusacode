import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idr } from "./money.ts";
import { messages } from "./i18n.ts";

const t = messages(
  {
    weekdays: "Sun Mon Tue Wed Thu Fri Sat",
    request: "{count} request",
    requests: "{count} requests",
    response: "{count} response",
    responses: "{count} responses",
    today: "Today",
    thisMonth: "This month",
    last7Days: "Last 7 days",
    allTime: "All time",
    titleToday: "today",
    titleWeek: "the last 7 days",
    titleMonth: "this month",
    titleAll: "all time",
    header: "NusaCode · usage history",
    nothingYet: "Nothing recorded yet. Spending is saved here as you use NusaCode.",
    perDay: "Per day",
    byModel: "By model, {period}",
    noUsagePeriod: "No usage in this period.",
    modelRow: "{name}  {cost} · {requests} · {average}/request · cache {cache}",
    unpriced: "{responses} had no price, so their cost is not counted.",
    otherPeriods: "Other periods: /usage history today | week | month | all",
  },
  {
    weekdays: "Min Sen Sel Rab Kam Jum Sab",
    request: "{count} permintaan",
    requests: "{count} permintaan",
    response: "{count} respons",
    responses: "{count} respons",
    today: "Hari ini",
    thisMonth: "Bulan ini",
    last7Days: "7 hari terakhir",
    allTime: "Sepanjang waktu",
    titleToday: "hari ini",
    titleWeek: "7 hari terakhir",
    titleMonth: "bulan ini",
    titleAll: "sepanjang waktu",
    header: "NusaCode · riwayat pemakaian",
    nothingYet: "Belum ada yang tercatat. Pengeluaran kamu disimpan di sini selama kamu memakai NusaCode.",
    perDay: "Per hari",
    byModel: "Per model, {period}",
    noUsagePeriod: "Belum ada pemakaian di periode ini.",
    modelRow: "{name}  {cost} · {requests} · {average}/permintaan · cache {cache}",
    unpriced: "{responses} tidak punya harga, jadi biayanya tidak dihitung.",
    otherPeriods: "Periode lain: /usage history today | week | month | all",
  },
);

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
  /** A day's summary stands for this many responses (1 when absent). */
  n?: number;
  /** How many of those had no price. */
  nu?: number;
};

export const LOG_FILE = "usage.jsonl";
/** Past this size, everything before today is folded into one line per day and model. */
const COMPACT_ABOVE_BYTES = 1_000_000;

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
      ...(Number.isInteger(row.n) && (row.n as number) > 0 ? { n: row.n as number } : {}),
      ...(Number.isInteger(row.nu) && (row.nu as number) > 0 ? { nu: row.nu as number } : {}),
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

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * Folds records from before today into one summary per local day, model and source. No report
 * looks closer than a day, so every total stays exactly the same, and the file stays small.
 */
export function compactRecords(records: LogRecord[], now: Date): LogRecord[] {
  const today = startOfDay(now).getTime();
  const days = new Map<string, LogRecord>();
  const recent: LogRecord[] = [];
  for (const record of records) {
    const at = new Date(record.t);
    if (at.getTime() >= today) {
      recent.push(record);
      continue;
    }
    const key = `${dayKey(at)}|${record.model}|${record.sub ? 1 : 0}`;
    const summary = days.get(key) ?? {
      // Noon, so a later change of time zone doesn't move the summary to another day.
      t: new Date(at.getFullYear(), at.getMonth(), at.getDate(), 12).toISOString(),
      model: record.model,
      cost: 0,
      fresh: 0,
      cached: 0,
      output: 0,
      ...(record.sub ? { sub: true as const } : {}),
      n: 0,
      nu: 0,
    };
    summary.cost += record.cost;
    summary.fresh += record.fresh;
    summary.cached += record.cached;
    summary.output += record.output;
    summary.n = (summary.n ?? 0) + (record.n ?? 1);
    summary.nu = (summary.nu ?? 0) + (record.nu ?? (record.unpriced ? 1 : 0));
    days.set(key, summary);
  }
  const summaries = [...days.values()].map((summary) => {
    const { nu, ...rest } = summary;
    return nu ? summary : rest;
  });
  return [...summaries.sort((a, b) => a.t.localeCompare(b.t)), ...recent];
}

/**
 * The compacted file, given what was read to compact (`before`) and what the file holds now
 * (`after`). Another NusaCode window may append in between, so those lines are carried over as they
 * are. If the file changed in any other way, null: writing would lose something.
 */
export function compactBytes(before: Buffer, after: Buffer, now: Date): Buffer | null {
  if (after.length < before.length || !after.subarray(0, before.length).equals(before)) return null;
  const records = before
    .toString("utf8")
    .split("\n")
    .flatMap((line) => {
      const record = line.trim() ? parseRecord(line) : null;
      return record ? [record] : [];
    });
  const body = compactRecords(records, now)
    .map((record) => `${JSON.stringify(record)}\n`)
    .join("");
  return Buffer.concat([Buffer.from(body, "utf8"), after.subarray(before.length)]);
}

/** Compacts the log once it has grown large; see compactRecords and compactBytes. */
export function compactLog(dir: string, now: Date): void {
  const file = join(dir, LOG_FILE);
  try {
    if (statSync(file).size <= COMPACT_ABOVE_BYTES) return;
    const before = readFileSync(file);
    // Read again: lines another window appended since are kept. Only one appended while the
    // compacted file is being written could still be lost, a window of milliseconds once in a long while.
    const compacted = compactBytes(before, readFileSync(file), now);
    if (compacted === null) return;
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, compacted);
    renameSync(temp, file);
  } catch {
    // Compacting is housekeeping: if it can't happen now, the next session tries again.
  }
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
  total.requests += record.n ?? 1;
  total.fresh += record.fresh;
  total.cached += record.cached;
  total.output += record.output;
  total.unpriced += record.nu ?? (record.unpriced ? 1 : 0);
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

/** Short weekday names, Sunday first, in the language in use. */
const weekdays = (): string[] => t("weekdays").split(" ");

/** Cost per local day for the last `days` days, oldest first, with empty days included. */
export function dailyCosts(records: LogRecord[], now: Date, days = 7): { label: string; cost: number }[] {
  const today = startOfDay(now);
  const names = weekdays();
  const rows = Array.from({ length: days }, (_, i) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i));
    return { day, label: `${names[day.getDay()]} ${String(day.getDate()).padStart(2, "0")}`, cost: 0 };
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
    return [label, `${idr(total.cost)} · ${requestCount(total.requests)}`];
  };
  return [row(t("today"), periodStart("today", now) as Date), row(t("thisMonth"), periodStart("month", now) as Date)];
}

const requestCount = (n: number) => t(n === 1 ? "request" : "requests", { count: n });
const responseCount = (n: number) => t(n === 1 ? "response" : "responses", { count: n });

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

function periodTitle(period: Period): string {
  if (period === "today") return t("titleToday");
  if (period === "week") return t("titleWeek");
  if (period === "month") return t("titleMonth");
  return t("titleAll");
}

/** The `/usage history` report. */
export function historyReport(records: LogRecord[], period: Period, now: Date): string {
  const header = t("header");
  const lines = [header, "─".repeat(header.length + 8)];
  if (records.length === 0) {
    lines.push(t("nothingYet"));
    return lines.join("\n");
  }
  const summaries: [string, Date | null][] = [
    [t("today"), periodStart("today", now)],
    [t("last7Days"), periodStart("week", now)],
    [t("thisMonth"), periodStart("month", now)],
    [t("allTime"), null],
  ];
  // Two spaces past the longest label (13 columns in English).
  const labelWidth = Math.max(...summaries.map(([label]) => label.length)) + 2;
  for (const [label, from] of summaries) {
    const total = totalOf(within(records, from));
    lines.push(`${label.padEnd(labelWidth)}${idr(total.cost)} · ${requestCount(total.requests)}`);
  }
  lines.push("", t("perDay"), ...bars(dailyCosts(records, now)));

  const scoped = within(records, periodStart(period, now));
  lines.push("", t("byModel", { period: periodTitle(period) }));
  const models = byModel(scoped);
  if (models.length === 0) lines.push(t("noUsagePeriod"));
  const nameWidth = Math.max(0, ...models.map(([name]) => name.length));
  for (const [name, total] of models) {
    const average = total.requests > 0 ? idr(total.cost / total.requests) : idr(0);
    lines.push(
      t("modelRow", {
        name: name.padEnd(nameWidth),
        cost: idr(total.cost),
        requests: requestCount(total.requests),
        average,
        cache: cachePercent(total),
      }),
    );
  }
  const unpriced = totalOf(scoped).unpriced;
  if (unpriced > 0) lines.push("", t("unpriced", { responses: responseCount(unpriced) }));
  lines.push("", t("otherPeriods"));
  return lines.join("\n");
}
