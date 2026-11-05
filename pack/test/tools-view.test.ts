import { test } from "node:test";
import assert from "node:assert/strict";
import { callTarget, cardLines, changeDiff, diffRows, diffSummary, formatDuration, outcome, summaryText, type Card } from "../extensions/tools-view.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, bg: (color: string, text: string) => `<${color}>${text}` };
const plain = (text: string) => text.replace(/[[0-9;]*m/g, "");
const result = (text: string) => ({ content: [{ type: "text", text }] });
const card = (over: Partial<Card> = {}): Card => ({
  name: "read",
  target: "src/app.ts",
  state: "done",
  summary: "42 lines · 0.3s",
  open: false,
  body: [],
  ...over,
});

test("formatDuration picks ms, seconds or minutes", () => {
  assert.equal(formatDuration(120), "120ms");
  assert.equal(formatDuration(1400), "1.4s");
  assert.equal(formatDuration(65_000), "1m 5s");
});

test("outcome counts lines for read, shells and listers", () => {
  assert.equal(outcome("read", result("a\nb\nc")), "3 lines");
  assert.equal(outcome("read", result("a")), "1 line");
  assert.equal(outcome("bash", result("")), "no output");
  assert.equal(outcome("powershell", result("x\ny")), "2 lines of output");
  assert.equal(outcome("grep", result("")), "no matches");
  assert.equal(outcome("ls", result("a\nb")), "2 entries");
  assert.equal(outcome("edit", result("ok")), undefined);
});

test("summaryText joins the outcome and the time", () => {
  assert.equal(summaryText("read", result("a\nb"), 300), "2 lines · 300ms");
  assert.equal(summaryText("edit", result("ok"), 2000), "2.0s");
  assert.equal(summaryText("edit", result("ok"), undefined), "");
});

test("callTarget picks the path, command or pattern on one line", () => {
  assert.equal(callTarget({ path: "a/b.ts" }), "a/b.ts");
  assert.equal(callTarget({ command: "npm  test\n -- x" }), "npm test -- x");
  assert.equal(callTarget({ pattern: "window_end" }), "window_end");
  assert.equal(callTarget(undefined), "");
});

test("a collapsed card is three rows of equal width with the summary on the right", () => {
  const lines = cardLines(card(), 60, theme);
  assert.equal(lines.length, 3);
  assert.deepEqual([...new Set(lines.map((line) => [...line].length))], [59]);
  assert.ok(lines[0].includes("╭") && lines[2].includes("╰"));
  assert.match(lines[1], /^ │ ✓ read src\/app\.ts +42 lines · 0.3s ▸ │$/);
});

test("an expanded card shows its body and a down arrow", () => {
  const lines = cardLines(card({ open: true, body: ["line one", "line two"] }), 50, theme);
  assert.equal(lines.length, 5);
  assert.ok(lines[1].includes("▾") && lines[2].includes("line one"));
});

test("an error card shows its body even when collapsed", () => {
  const lines = cardLines(card({ state: "error", summary: "1.5s", body: ["boom"] }), 50, theme);
  assert.ok(lines[1].startsWith(" │ ✗ read") && lines[2].includes("boom"));
});

test("a long target is cut so the summary stays visible", () => {
  const lines = cardLines(card({ target: "x".repeat(200) }), 50, theme);
  assert.ok(lines[1].includes("…") && lines[1].includes("42 lines") && [...plain(lines[1])].length === 49);
});

test("a very narrow terminal falls back to one plain line", () => {
  assert.equal(cardLines(card(), 10, theme).length, 1);
});

test("a write is shown as every line added", () => {
  assert.equal(changeDiff("write", { content: "a\nb\n" }, undefined), "+1 a\n+2 b");
  assert.equal(changeDiff("write", {}, undefined), undefined);
  assert.equal(changeDiff("read", { content: "a" }, undefined), undefined);
});

test("an edit uses the diff pi recorded", () => {
  assert.equal(changeDiff("edit", {}, { details: { diff: "-1 a\n+1 b" } }), "-1 a\n+1 b");
  assert.equal(changeDiff("edit", {}, { details: {} }), undefined);
});

test("a long diff line wraps under the code instead of being cut", () => {
  const rows = diffRows("+12 " + "word ".repeat(12), 30, theme);
  assert.ok(rows.length > 1);
  assert.ok(rows[0].includes("12") && rows[1].startsWith("<toolSuccessBg>       "));
  assert.ok(rows.every((row) => [...row.replace(/^<[a-zA-Z]+>/, "")].length === 30));
});

test("diffSummary counts added and removed lines", () => {
  assert.equal(diffSummary("+1 a\n+2 b\n 3 c"), "Added 2 lines");
  assert.equal(diffSummary("-1 a\n+1 b"), "Added 1 line, removed 1 line");
});

test("diffRows paints added and removed rows and leaves context plain", () => {
  const rows = diffRows("-3 old\n+3 new\n 4 same", 20, theme);
  assert.ok(rows[0].startsWith("<toolErrorBg>") && rows[0].includes("- old"));
  assert.ok(rows[1].startsWith("<toolSuccessBg>") && rows[1].includes("+ new"));
  assert.ok(!rows[2].startsWith("<") && rows[2].includes("same"));
  assert.ok(rows.every((row) => [...row.replace(/^<[a-zA-Z]+>/, "")].length === 20));
});
