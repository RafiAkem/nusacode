import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import effort, { levelLabel, parseLevel, supportedLevels } from "../extensions/effort.ts";

test("a model without reasoning only has off", () => {
  assert.deepEqual(supportedLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(supportedLevels(undefined), ["off"]);
});

test("a reasoning model gets the five base levels, and the top two only when mapped", () => {
  assert.deepEqual(supportedLevels({ reasoning: true }), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(supportedLevels({ reasoning: true, thinkingLevelMap: { xhigh: "x", max: "m" } }), [
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);
});

test("a level mapped to null is not offered", () => {
  assert.ok(!supportedLevels({ reasoning: true, thinkingLevelMap: { minimal: null } }).includes("minimal"));
});

test("parseLevel is forgiving about case and spaces", () => {
  assert.equal(parseLevel(" High "), "high");
  assert.equal(parseLevel("turbo"), undefined);
  assert.equal(parseLevel(""), undefined);
});

test("levelLabel marks the current level", () => {
  assert.ok(levelLabel("medium", "medium").startsWith("● medium"));
  assert.ok(levelLabel("low", "medium").startsWith("○ low"));
});

type Handler = (args: string, ctx: unknown) => Promise<void>;

function setup(model: unknown, current = "medium", pick?: (labels: string[]) => string | undefined) {
  let handler: Handler | undefined;
  const set: string[] = [];
  const notes: string[] = [];
  const pi = {
    registerCommand: (_name: string, options: { handler: Handler }) => (handler = options.handler),
    getThinkingLevel: () => current,
    setThinkingLevel: (level: string) => {
      set.push(level);
      current = level;
    },
  } as unknown as ExtensionAPI;
  effort(pi);
  const ctx = { model, ui: { notify: (text: string) => notes.push(text), select: async (_t: string, labels: string[]) => pick?.(labels) } };
  return { run: (args: string) => handler!(args, ctx), set, notes };
}

const reasoner = { name: "DeepSeek", reasoning: true };

test("/effort high sets the level", async () => {
  const { run, set, notes } = setup(reasoner);
  await run("high");
  assert.deepEqual(set, ["high"]);
  assert.match(notes[0], /Reasoning effort: high/);
});

test("/effort with no argument lets you pick from the supported levels", async () => {
  const { run, set } = setup(reasoner, "medium", (labels) => labels.find((label) => label.includes(" low ")));
  await run("");
  assert.deepEqual(set, ["low"]);
});

test("cancelling the pick changes nothing", async () => {
  const { run, set } = setup(reasoner, "medium", () => undefined);
  await run("");
  assert.deepEqual(set, []);
});

test("unknown or unsupported levels are explained, not applied", async () => {
  const { run, set, notes } = setup(reasoner);
  await run("turbo");
  await run("max");
  assert.deepEqual(set, []);
  assert.match(notes[0], /Unknown effort "turbo"/);
  assert.match(notes[1], /doesn't support "max"/);
});

test("a model that cannot reason says so", async () => {
  const { run, set, notes } = setup({ name: "Plain", reasoning: false }, "off");
  await run("high");
  assert.deepEqual(set, []);
  assert.match(notes[0], /no adjustable reasoning/);
});
