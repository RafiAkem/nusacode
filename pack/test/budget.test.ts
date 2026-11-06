import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUDGET_FILE, levelOf, parseCommand, raisedLimit, readDefaults, writeDefaults } from "../lib/budget.ts";
import { idr, parseIdr } from "../lib/money.ts";
import budget from "../extensions/budget.ts";
import { COST_CHANNEL, type CostEvent } from "../extensions/meter.ts";

test("amounts are read the way people type them", () => {
  for (const [text, expected] of [
    ["5000", 5000],
    ["5.000", 5000],
    ["5,000", 5000],
    ["Rp 5.000", 5000],
    ["rp5000", 5000],
    ["5k", 5000],
    ["5rb", 5000],
    ["1.5m", 1_500_000],
    ["1,5jt", 1_500_000],
    ["1.234.567", 1_234_567],
  ] as const) {
    assert.equal(parseIdr(text), expected, text);
  }
  for (const bad of ["", "abc", "0", "-5", "12.5", "5.00", "1.2345k", "5 apples", "1e9", "Rp"]) {
    assert.equal(parseIdr(bad), null, bad);
  }
});

test("idr groups thousands with dots", () => {
  assert.equal(idr(1234567), "Rp 1.234.567");
  assert.equal(idr(0), "Rp 0");
});

test("the command grammar", () => {
  assert.deepEqual(parseCommand(""), { kind: "show" });
  assert.deepEqual(parseCommand("5000"), { kind: "set", target: "session", amount: 5000, remember: false });
  assert.deepEqual(parseCommand("Rp 5.000 --default"), { kind: "set", target: "session", amount: 5000, remember: true });
  assert.deepEqual(parseCommand("off"), { kind: "set", target: "session", amount: null, remember: false });
  assert.deepEqual(parseCommand("turn 500"), { kind: "set", target: "turn", amount: 500, remember: false });
  assert.deepEqual(parseCommand("TURN off --default"), { kind: "set", target: "turn", amount: null, remember: true });
  assert.equal(parseCommand("lots").kind, "error");
  assert.equal(parseCommand("turn").kind, "error");
  assert.equal(parseCommand("--default").kind, "error");
});

test("warning at 80% and stopping at 100%", () => {
  assert.equal(levelOf(100, null), "ok");
  assert.equal(levelOf(799, 1000), "ok");
  assert.equal(levelOf(800, 1000), "warn");
  assert.equal(levelOf(1000, 1000), "over");
  assert.equal(raisedLimit(1030, 1000), 2100);
});

test("defaults survive a round trip, and a broken file means no limits", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readDefaults(dir), { sessionIdr: null, turnIdr: null });
  writeDefaults(dir, { sessionIdr: 5000, turnIdr: null });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, BUDGET_FILE), "utf8")), { session: 5000 });
  assert.deepEqual(readDefaults(dir), { sessionIdr: 5000, turnIdr: null });
  writeFileSync(join(dir, BUDGET_FILE), JSON.stringify({ session: -3, turn: "x" }));
  assert.deepEqual(readDefaults(dir), { sessionIdr: null, turnIdr: null });
  writeFileSync(join(dir, BUDGET_FILE), "{ nope");
  assert.deepEqual(readDefaults(dir), { sessionIdr: null, turnIdr: null });
});

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The budget extension against a fake pi, with a home of its own. */
function harness(t: { after(fn: () => void): void }, options: { defaults?: unknown; hasUI?: boolean; answer?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-budget-"));
  const previous = process.env.NUSACODE_CODING_AGENT_DIR;
  process.env.NUSACODE_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.NUSACODE_CODING_AGENT_DIR;
    else process.env.NUSACODE_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  if (options.defaults !== undefined) writeFileSync(join(dir, BUDGET_FILE), JSON.stringify(options.defaults));

  const handlers: Record<string, Handler> = {};
  const busHandlers: Record<string, (data: unknown) => void> = {};
  let command: (args: string, ctx: unknown) => Promise<void> = async () => {};
  const notes: { message: string; level?: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const asked: { title: string; options: string[] }[] = [];
  let aborts = 0;
  let idle = true;
  let editor = "";
  const ctx = {
    hasUI: options.hasUI ?? true,
    isIdle: () => idle,
    abort: () => {
      aborts += 1;
    },
    ui: {
      notify: (message: string, level?: string) => notes.push({ message, level }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      select: async (title: string, choices: string[]) => {
        asked.push({ title, options: choices });
        return options.answer === undefined ? undefined : choices.find((choice) => choice.startsWith(options.answer as string));
      },
      setEditorText: (text: string) => {
        editor = text;
      },
    },
  };
  budget({
    on: (name: string, fn: Handler) => {
      handlers[name] = fn;
    },
    events: { on: (channel: string, fn: (data: unknown) => void) => (busHandlers[channel] = fn) },
    registerCommand: (_name: string, def: { handler: typeof command }) => {
      command = def.handler;
    },
  } as unknown as ExtensionAPI);
  const cost = (sessionIdr: number, extra: Partial<CostEvent> = {}) =>
    busHandlers[COST_CHANNEL]({
      provider: "nusagate",
      model: "m",
      costIdr: 0,
      sessionIdr,
      unpriced: false,
      freshInput: 0,
      cacheRead: 0,
      output: 0,
      source: "main",
      ...extra,
    });
  return {
    handlers,
    notes,
    statuses,
    asked,
    cost,
    get aborts() {
      return aborts;
    },
    get editor() {
      return editor;
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
    start: () => handlers.session_start({}, ctx),
    agentStart: () => handlers.agent_start({}, ctx),
    run: (args: string) => command(args, ctx),
    input: (text: string) => handlers.input({ text }, ctx) as Promise<{ action: string }>,
    toolCall: () => handlers.tool_call({ toolName: "bash" }, ctx) as { block?: boolean } | undefined,
    dir,
  };
}

test("with no limit nothing is warned, stopped or asked", async (t) => {
  const h = harness(t);
  h.start();
  h.cost(1_000_000);
  assert.equal(h.notes.length, 0);
  assert.equal((await h.input("hi")).action, "continue");
  assert.equal(h.toolCall(), undefined);
});

test("the session limit warns once at 80%, then stops the agent at 100%", async (t) => {
  const h = harness(t);
  h.start();
  await h.run("1000");
  h.agentStart();
  h.setIdle(false);
  h.cost(700);
  assert.equal(h.notes.length, 1, "only the /budget confirmation so far");
  h.cost(850);
  h.cost(900);
  assert.equal(h.notes.filter((n) => n.level === "warning").length, 1);
  assert.equal(h.aborts, 0);
  h.cost(1010);
  h.cost(1100);
  assert.equal(h.aborts, 1, "aborted once, not on every later response");
  assert.match(h.notes.at(-1)?.message ?? "", /Session budget reached: Rp 1\.010 of Rp 1\.000/);
  assert.deepEqual(h.toolCall(), { block: true, reason: "The session budget has been reached.", terminate: true });
});

test("a message after the limit asks what to do, and raising the limit lets it through", async (t) => {
  const h = harness(t, { answer: "Raise" });
  h.start();
  await h.run("1000");
  h.cost(1050);
  const result = await h.input("keep going");
  assert.equal(result.action, "continue");
  assert.match(h.asked[0].title, /Rp 1\.000 reached \(spent Rp 1\.050\)/);
  assert.match(h.asked[0].options[0], /Raise the limit to Rp 2\.100/);
  assert.equal(h.toolCall(), undefined);
  assert.equal((await h.input("again")).action, "continue");
  assert.equal(h.asked.length, 1, "no second question once raised");
});

test("sending without a limit removes it, and declining keeps the typed text", async (t) => {
  const remove = harness(t, { answer: "Send without" });
  remove.start();
  await remove.run("1000");
  remove.cost(1000);
  assert.equal((await remove.input("go")).action, "continue");
  assert.equal(remove.statuses.at(-1), undefined);

  const decline = harness(t, { answer: "Don't" });
  decline.start();
  await decline.run("1000");
  decline.cost(1000);
  assert.equal((await decline.input("my long prompt")).action, "handled");
  assert.equal(decline.editor, "my long prompt");
  assert.equal(decline.toolCall()?.block, true);
});

test("without a screen, an over-budget message is refused instead of asked about", async (t) => {
  const h = harness(t, { hasUI: false });
  h.start();
  await h.run("500");
  h.cost(600);
  assert.equal((await h.input("go")).action, "handled");
  assert.equal(h.asked.length, 0);
  assert.match(h.notes.at(-1)?.message ?? "", /Nothing was sent/);
});

test("the prompt warning comes once per prompt and counts subagents", async (t) => {
  const h = harness(t);
  h.start();
  await h.run("turn 300");
  h.cost(500); // background spending before a prompt: never blamed on one
  assert.equal(h.notes.filter((n) => n.level === "warning").length, 0);
  h.agentStart();
  h.cost(700);
  assert.equal(h.notes.filter((n) => n.level === "warning").length, 0);
  h.cost(850, { source: "subagent" });
  h.cost(900);
  assert.equal(h.notes.filter((n) => n.level === "warning").length, 1);
  assert.match(h.notes.at(-1)?.message ?? "", /This prompt has cost Rp 350 so far/);
  h.handlers.agent_end({}, {});
  h.cost(1000); // between prompts: no warning
  assert.equal(h.notes.filter((n) => n.level === "warning").length, 1);
  h.agentStart();
  h.cost(1300);
  assert.equal(h.notes.filter((n) => n.level === "warning").length, 2, "warns again on the next prompt");
});

test("defaults apply to a new session, and --default saves them", async (t) => {
  const h = harness(t, { defaults: { session: 2000 } });
  h.start();
  assert.match(h.statuses.at(-1) ?? "", /budget Rp 2\.000 left/);
  await h.run("turn 400 --default");
  assert.deepEqual(readDefaults(h.dir), { sessionIdr: 2000, turnIdr: 400 });
  await h.run("off --default");
  assert.deepEqual(readDefaults(h.dir), { sessionIdr: null, turnIdr: 400 });
  h.start();
  assert.equal(h.statuses.at(-1), undefined, "no session limit, so nothing in the status bar");
});

test("/budget reports what is spent, bad input is explained, and unpriced models are flagged", async (t) => {
  const h = harness(t);
  h.start();
  await h.run("2000");
  h.cost(500);
  await h.run("");
  assert.match(h.notes.at(-1)?.message ?? "", /Session {1,}Rp 500 of Rp 2\.000 · Rp 1\.500 left/);
  assert.match(h.notes.at(-1)?.message ?? "", /Prompt {1,}no limit/);
  h.cost(500, { unpriced: true });
  await h.run("");
  assert.match(h.notes.at(-1)?.message ?? "", /had no price/);
  await h.run("plenty");
  assert.match(h.notes.at(-1)?.message ?? "", /not an amount/);
  assert.equal(h.notes.at(-1)?.level, "warning");
});

test("setting a limit below what is already spent says so", async (t) => {
  const h = harness(t);
  h.start();
  h.cost(900);
  await h.run("500");
  assert.match(h.notes.at(-1)?.message ?? "", /Rp 900 is already spent/);
});

test("with a limit set, a response that can't be priced is pointed out once", async (t) => {
  const h = harness(t);
  h.start();
  h.cost(0, { unpriced: true });
  assert.equal(h.notes.length, 0, "no limit, nothing to protect, nothing said");
  await h.run("1000");
  assert.match(h.notes.at(-1)?.message ?? "", /Note: some responses so far had no price/);
  h.cost(0, { unpriced: true });
  assert.equal(h.notes.filter((n) => n.level === "warning").length, 0, "already said when the limit was set");

  const fresh = harness(t);
  fresh.start();
  await fresh.run("1000");
  fresh.cost(0, { unpriced: true });
  fresh.cost(0, { unpriced: true });
  const warnings = fresh.notes.filter((n) => n.level === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /had no price, and the budget can't count responses without a price .* can pass the limit without a warning/);
  fresh.start();
  await fresh.run("1000");
  fresh.cost(0, { unpriced: true });
  assert.equal(fresh.notes.filter((n) => n.level === "warning").length, 2, "said again in a new session");
});
