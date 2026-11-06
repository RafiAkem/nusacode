import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  LOG_FILE,
  appendRecord,
  byModel,
  dailyCosts,
  historyReport,
  parsePeriod,
  periodRows,
  periodStart,
  pruneLog,
  readLog,
  totalOf,
  within,
  type LogRecord,
} from "../lib/usage-log.ts";
import history from "../extensions/history.ts";
import { COST_CHANNEL, type CostEvent } from "../extensions/meter.ts";

/** Saturday 7 November 2026, mid-afternoon, local time. */
const NOW = new Date(2026, 10, 7, 15, 30);
const at = (daysAgo: number, hour = 12) => new Date(2026, 10, 7 - daysAgo, hour).toISOString();
const record = (t: string, model: string, cost: number, extra: Partial<LogRecord> = {}): LogRecord => ({
  t,
  model,
  cost,
  fresh: 1000,
  cached: 0,
  output: 100,
  ...extra,
});

const tempDir = (t: { after(fn: () => void): void }) => {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("records round trip through the file, and broken lines are skipped", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readLog(dir), [], "no file yet");
  const first = record(at(0), "nusagate/a", 10, { session: "s1", sub: true });
  appendRecord(dir, first);
  appendFileSync(join(dir, LOG_FILE), "not json\n{\"t\":\"nope\",\"model\":\"x\"}\n{\"t\":\"2026-11-07T00:00:00Z\",\"model\":\"x\",\"cost\":-1,\"fresh\":0,\"cached\":0,\"output\":0}\n\n");
  appendRecord(dir, record(at(0), "nusagate/b", 20, { unpriced: true }));
  const read = readLog(dir);
  assert.equal(read.length, 2);
  assert.deepEqual(read[0], first);
  assert.equal(read[1].unpriced, true);
});

test("periods start at local midnight, six days back, and the first of the month", () => {
  assert.deepEqual(periodStart("today", NOW), new Date(2026, 10, 7));
  assert.deepEqual(periodStart("week", NOW), new Date(2026, 10, 1));
  assert.deepEqual(periodStart("month", NOW), new Date(2026, 10, 1));
  assert.equal(periodStart("all", NOW), null);
  assert.deepEqual(periodStart("week", new Date(2026, 10, 3)), new Date(2026, 9, 28), "a week can start in the last month");
  assert.equal(parsePeriod(""), "month");
  assert.equal(parsePeriod(" Week "), "week");
  assert.equal(parsePeriod("year"), null);
});

test("totals, per-model roll-ups ordered by cost, and a day-by-day series", () => {
  const records = [
    record(at(0, 9), "nusagate/cheap", 100, { cached: 3000 }),
    record(at(0, 10), "nusagate/pricey", 900),
    record(at(2), "nusagate/cheap", 50),
    record(at(40), "nusagate/pricey", 5000),
    record(at(0, 11), "nusagate/pricey", 0, { unpriced: true }),
  ];
  assert.equal(totalOf(within(records, periodStart("today", NOW))).cost, 1000);
  assert.equal(totalOf(within(records, periodStart("month", NOW))).requests, 4);
  assert.equal(totalOf(records).cost, 6050);
  assert.deepEqual(byModel(records).map(([name, total]) => [name, total.cost, total.requests]), [
    ["nusagate/pricey", 5900, 3],
    ["nusagate/cheap", 150, 2],
  ]);
  const days = dailyCosts(records, NOW);
  assert.equal(days.length, 7);
  assert.deepEqual(days.at(-1), { label: "Sat 07", cost: 1000 });
  assert.deepEqual(days.at(-3), { label: "Thu 05", cost: 50 });
  assert.deepEqual(days.at(0), { label: "Sun 01", cost: 0 });
});

test("the history report shows the periods, per-day bars and the models side by side", () => {
  const records = [
    record(at(0), "nusagate/deepseek-v4.1-flash", 1200, { fresh: 1000, cached: 3000 }),
    record(at(0), "nusagate/deepseek-v4.1-flash", 800, { fresh: 1000, cached: 3000 }),
    record(at(3), "nusagate/gpt-6-sol", 3000),
    record(at(0), "nusagate/gpt-6-sol", 0, { unpriced: true }),
  ];
  const report = historyReport(records, "month", NOW);
  assert.match(report, /Today +Rp 2\.000 · 3 requests/);
  assert.match(report, /Last 7 days +Rp 5\.000 · 4 requests/);
  assert.match(report, /This month +Rp 5\.000 · 4 requests/);
  assert.match(report, /Sat 07 +█+░* Rp 2\.000/);
  assert.match(report, /By model, this month/);
  assert.match(report, /nusagate\/deepseek-v4\.1-flash +Rp 2\.000 · 2 requests · Rp 1\.000\/request · cache 75%/);
  assert.match(report, /nusagate\/gpt-6-sol +Rp 3\.000 · 2 requests · Rp 1\.500\/request · cache 0%/);
  assert.ok(report.indexOf("gpt-6-sol") < report.indexOf("deepseek"), "the costlier model comes first");
  assert.match(report, /1 response had no price/);
  assert.match(historyReport(records, "today", NOW), /By model, today[\s\S]*deepseek[\s\S]*Other periods/);
  assert.doesNotMatch(historyReport(records, "today", NOW), /gpt-6-sol +Rp 3\.000/);
});

test("an empty history says so instead of printing zeros", () => {
  assert.match(historyReport([], "month", NOW), /Nothing recorded yet/);
  assert.deepEqual(periodRows([], NOW), []);
  const rows = periodRows([record(at(0), "nusagate/a", 70)], NOW);
  assert.deepEqual(rows, [
    ["Today", "Rp 70 · 1 request"],
    ["This month", "Rp 70 · 1 request"],
  ]);
});

test("a big log loses its oldest records, and a small one is left alone", (t) => {
  const dir = tempDir(t);
  const old = record(at(500), "nusagate/a", 1);
  const recent = record(at(1), "nusagate/a", 2);
  writeFileSync(join(dir, LOG_FILE), [old, recent].map((r) => `${JSON.stringify(r)}\n`).join(""));
  pruneLog(dir, NOW);
  assert.equal(readLog(dir).length, 2, "under the size limit: untouched");
  appendFileSync(join(dir, LOG_FILE), `${JSON.stringify(record(at(1), "nusagate/a", 3, { session: "x".repeat(2_000_000) }))}\n`);
  assert.ok(statSync(join(dir, LOG_FILE)).size > 2_000_000);
  pruneLog(dir, NOW);
  assert.deepEqual(readLog(dir).map((r) => r.cost), [2, 3], "the 500-day-old record is dropped");
  pruneLog(tempDir(t), NOW); // no file: no error
});

test("the history extension records each priced response with its session", (t) => {
  const dir = tempDir(t);
  const previous = process.env.NUSACODE_CODING_AGENT_DIR;
  process.env.NUSACODE_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.NUSACODE_CODING_AGENT_DIR;
    else process.env.NUSACODE_CODING_AGENT_DIR = previous;
  });
  const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
  let onCost: (data: unknown) => void = () => {};
  history({
    on: (name: string, fn: (event: unknown, ctx: unknown) => void) => {
      handlers[name] = fn;
    },
    events: {
      on: (channel: string, fn: (data: unknown) => void) => {
        if (channel === COST_CHANNEL) onCost = fn;
      },
    },
  } as unknown as ExtensionAPI);
  const ctx = { sessionManager: { getSessionId: () => "session-1" } };
  handlers.session_start({}, ctx);
  const event: CostEvent = { provider: "nusagate", model: "m", costIdr: 42, sessionIdr: 42, unpriced: false, freshInput: 10, cacheRead: 20, output: 30, source: "main" };
  onCost(event);
  onCost({ ...event, costIdr: 0, unpriced: true, source: "subagent" });
  const [first, second] = readLog(dir);
  assert.deepEqual([first.model, first.cost, first.fresh, first.cached, first.output, first.session], ["nusagate/m", 42, 10, 20, 30, "session-1"]);
  assert.equal(first.sub, undefined);
  assert.equal(second.sub, true);
  assert.equal(second.unpriced, true);
  assert.doesNotMatch(readFileSync(join(dir, LOG_FILE), "utf8"), /prompt|content|text/i, "only counts and names are stored");
});

test("a log that can't be written never breaks the session", (t) => {
  const dir = tempDir(t);
  const previous = process.env.NUSACODE_CODING_AGENT_DIR;
  // A file where the folder should be, so every write fails.
  writeFileSync(join(dir, "blocked"), "");
  process.env.NUSACODE_CODING_AGENT_DIR = join(dir, "blocked");
  t.after(() => {
    if (previous === undefined) delete process.env.NUSACODE_CODING_AGENT_DIR;
    else process.env.NUSACODE_CODING_AGENT_DIR = previous;
  });
  let onCost: (data: unknown) => void = () => {};
  history({
    on: () => {},
    events: { on: (_channel: string, fn: (data: unknown) => void) => (onCost = fn) },
  } as unknown as ExtensionAPI);
  assert.doesNotThrow(() => onCost({ provider: "p", model: "m", costIdr: 1, sessionIdr: 1, unpriced: false, freshInput: 0, cacheRead: 0, output: 0, source: "main" }));
});
