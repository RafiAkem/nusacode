import { test } from "node:test";
import assert from "node:assert/strict";
import { answersText, AskPanel, normalizeQuestions, type AskResult, type Question } from "../lib/ask-panel.ts";
import { askBody, callTarget } from "../extensions/tools-view.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const ENTER = "\r";
const ESC = "\x1b";

const framework: Question = {
  question: "Which framework?",
  header: "Framework",
  options: [{ label: "Vitest (Recommended)", description: "Fast, ESM native" }, { label: "Jest" }],
};
const features: Question = {
  question: "Which features?",
  header: "Features",
  multiSelect: true,
  options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
};

function open(questions: Question[]) {
  const results: AskResult[] = [];
  const panel = new AskPanel(questions, theme, (result) => results.push(result));
  const press = (...keys: string[]) => keys.forEach((key) => panel.handleInput(key));
  return { panel, press, results };
}

test("normalizeQuestions accepts a good question and trims it", () => {
  const out = normalizeQuestions([{ question: " Pick? ", options: [{ label: " A " }, { label: "B", description: " why " }] }]);
  assert.ok(Array.isArray(out));
  assert.deepEqual(out[0].options, [{ label: "A", description: undefined }, { label: "B", description: "why" }]);
});

test("normalizeQuestions explains what is wrong", () => {
  assert.match(normalizeQuestions([]) as string, /at least one/);
  assert.match(normalizeQuestions(new Array(5).fill({})) as string, /at most 4/);
  assert.match(normalizeQuestions([{ question: "", options: [] }]) as string, /Question 1 has no text/);
  assert.match(normalizeQuestions([{ question: "q", options: [{ label: "only" }] }]) as string, /needs 2 to 4 options/);
});

test("answersText reports answers, or a dismissal the model can act on", () => {
  assert.equal(answersText({ answers: [{ question: "Which framework?", header: "Framework", picked: ["Jest"] }] }), "The user answered:\n- Framework: Jest");
  assert.match(answersText(undefined), /dismissed/);
});

test("enter picks the highlighted option and finishes a single question", () => {
  const { press, results } = open([framework]);
  press(DOWN, ENTER);
  assert.deepEqual(results, [{ answers: [{ question: "Which framework?", header: "Framework", picked: ["Jest"] }] }]);
});

test("up from the first option wraps to Other, and Other takes typed text", () => {
  const { panel, press, results } = open([framework]);
  press(UP, ENTER, ..."mocha", ENTER);
  assert.ok(plain(panel.render(60).join("\n")).includes("Other"));
  assert.deepEqual(results[0]?.answers[0].picked, ["mocha"]);
});

test("esc while typing goes back to the list; esc on the list dismisses", () => {
  const { press, results } = open([framework]);
  press(UP, ENTER, ESC);
  assert.equal(results.length, 0);
  press(ESC);
  assert.deepEqual(results, [undefined]);
});

test("a multi-select toggles with space and confirms with enter", () => {
  const { press, results } = open([features]);
  press(" ", DOWN, DOWN, " ", ENTER);
  assert.deepEqual(results[0]?.answers[0].picked, ["Auth", "Search"]);
});

test("several questions move on after each answer and finish after the last", () => {
  const { panel, press, results } = open([framework, features]);
  press(ENTER);
  assert.equal(results.length, 0);
  assert.ok(plain(panel.render(60).join("\n")).includes("Which features?"));
  press(DOWN, " ", ENTER);
  assert.deepEqual(results[0]?.answers.map((a) => a.picked), [["Vitest (Recommended)"], ["Billing"]]);
});

test("tab switches question without answering", () => {
  const { panel, press, results } = open([framework, features]);
  press(TAB);
  assert.ok(plain(panel.render(60).join("\n")).includes("Which features?"));
  assert.equal(results.length, 0);
});

test("the panel is a closed box of equal-width rows with options and descriptions", () => {
  const { panel } = open([framework, features]);
  const lines = panel.render(50).map(plain);
  assert.deepEqual([...new Set(lines.map((line) => [...line].length))], [50]);
  const text = lines.join("\n");
  for (const expected of ["╭", "╰", "Which framework?", "1. Vitest (Recommended)", "Fast, ESM native", "Other…", "dismiss"]) {
    assert.ok(text.includes(expected), `missing ${expected}\n${text}`);
  }
});

test("the transcript card names the first question and lists the answers", () => {
  assert.equal(callTarget({ questions: [{ question: "A?" }, { question: "B?" }] }), "A? (+1 more)");
  const rows = askBody({ details: { answers: [{ question: "Which framework?", picked: ["Jest"] }] } }, theme);
  assert.deepEqual(rows, ["Which framework?", "  → Jest"]);
  assert.equal(askBody({ details: { dismissed: true, answers: [] } }, theme), undefined);
});
