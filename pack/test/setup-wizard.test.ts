import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  dissolve,
  renderFrame,
  runSetupWizard,
  SetupWizard,
  stepIndicator,
  type SetupStep,
  type StepDefinition,
  type StepHost,
  type WizardOutcome,
} from "../lib/setup-wizard.ts";
import {
  importHeadline,
  importStep,
  keyStep,
  languageStep,
  contextLabel,
  maskKey,
  modelColumns,
  modelStep,
  readyStep,
  summaryLines,
  type KeyCheck,
  type KeyOutcome,
  type ModelChoice,
} from "../lib/setup-steps.ts";
import { locale, setLocale } from "../lib/i18n.ts";
import { LANGUAGES } from "../lib/language.ts";

// The wizard's timer is unref'd so it can't hold the CLI open; keep the loop alive for awaits.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines: readonly string[]): string[] => lines.map((line) => line.replace(ANSI, ""));
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, getColorMode: () => "truecolor" as const };
const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A step that records its keys and finishes on enter. */
function simpleStep(id: string, log: string[], skip?: () => boolean): StepDefinition {
  return {
    id,
    label: id,
    skip,
    create: (host) => {
      log.push(`mount ${id}`);
      return {
        title: `Title ${id}`,
        subtitle: `About ${id}`,
        render: () => [`body of ${id}`],
        hints: () => "enter next",
        handleInput: (data) => {
          if (data === ENTER) host.finish("done");
          if (data === ESC) host.finish("skipped");
        },
      };
    },
  };
}

function makeWizard(steps: StepDefinition[], options = {}) {
  let outcome: WizardOutcome | null = null;
  let renders = 0;
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender: () => void renders++ };
  const wizard = new SetupWizard(tui, theme, steps, (value) => (outcome = value), { splash: false, tickMs: 5, ...options });
  return { wizard, outcome: () => outcome, renders: () => renders };
}

/** A clock and host for driving one step by hand. */
function stepHarness() {
  const results: string[] = [];
  let clock = 0;
  const host: StepHost = { theme, requestRender: () => {}, finish: (r) => void results.push(r), now: () => clock };
  return { host, results, advance: (ms: number) => (clock += ms) };
}

const body = (step: SetupStep, width = 70, lines = 20): string => plain(step.render(width, lines)).join("\n");

test("a step frame fills the screen exactly and keeps the keys on the last row", () => {
  for (const [width, height] of [
    [80, 24],
    [140, 40],
    [40, 12],
  ]) {
    const frame = renderFrame({
      width,
      height,
      theme,
      labels: ["API key", "Model", "Ready"],
      states: ["done", "current", "todo"],
      title: "Pick your default model",
      subtitle: "New sessions start on this one.",
      hints: "enter choose",
      body: (_w, max) => Array.from({ length: max + 10 }, (_, i) => `row ${i}`),
    });
    const lines = plain(frame);
    assert.equal(lines.length, height, `${width}x${height}`);
    for (const line of lines) assert.equal(line.length, width, `${width}x${height}`);
    assert.match(lines[height - 1]!, /enter choose/);
    assert.match(lines.join("\n"), /NusaCode setup/);
  }
});

test("the step indicator marks done, current and upcoming steps, and shrinks when narrow", () => {
  const labels = ["API key", "Model", "Import", "Ready"];
  const states = ["done", "current", "skipped", "todo"] as const;
  assert.equal(stepIndicator(labels, states, theme, 80), "✓ API key ── ● Model ── – Import ── ○ Ready");
  assert.equal(stepIndicator(labels, states, theme, 20), "● Model");
});

test("the dissolve starts on the old frame and ends on the new one", () => {
  const from = Array.from({ length: 10 }, () => "old");
  const to = Array.from({ length: 10 }, () => "new");
  assert.deepEqual(dissolve(from, to, 0, 10), from);
  assert.deepEqual(dissolve(from, to, 1, 10), to);
  const middle = dissolve(from, to, 0.5, 10);
  assert.ok(middle.includes("old") && middle.includes("new"));
  assert.equal(middle[0], "new", "the top goes first");
});

test("steps run in order, skip themselves when asked, and the wizard completes after the last", async () => {
  const log: string[] = [];
  const { wizard, outcome } = makeWizard([simpleStep("a", log), simpleStep("b", log, () => true), simpleStep("c", log)]);
  assert.equal(wizard.currentStep, 0);
  assert.match(plain(wizard.render(80)).join("\n"), /Title a/);
  wizard.handleInput(ENTER);
  assert.equal(wizard.currentStep, 2, "b skipped itself");
  assert.deepEqual(wizard.stepStates, ["done", "skipped", "current"]);
  wizard.handleInput(ENTER);
  assert.equal(outcome(), "completed");
  assert.deepEqual(log, ["mount a", "mount c"]);
  wizard.handleInput(ENTER);
  assert.equal(outcome(), "completed", "input after the end is ignored");
});

test("a step that finishes twice only moves the wizard once", () => {
  let host: StepHost | null = null;
  const capture: StepDefinition = {
    id: "x",
    label: "x",
    create: (h) => {
      host = h;
      return { title: "x", render: () => [], hints: () => "", handleInput: () => {} };
    },
  };
  const log: string[] = [];
  const { wizard } = makeWizard([capture, simpleStep("b", log), simpleStep("c", log)]);
  host!.finish("done");
  host!.finish("done");
  assert.equal(wizard.currentStep, 1);
});

test("ctrl+c closes the wizard as cancelled", () => {
  const { wizard, outcome } = makeWizard([simpleStep("a", [])]);
  wizard.handleInput("\x03");
  assert.equal(outcome(), "cancelled");
});

test("the splash plays first, and enter cuts it short", async () => {
  const log: string[] = [];
  const { wizard } = makeWizard([simpleStep("a", log)], { splash: true, splashMs: 60_000 });
  assert.equal(wizard.currentStep, -1);
  assert.equal(plain(wizard.render(80)).length, 24);
  wizard.handleInput(ENTER);
  assert.equal(wizard.currentStep, 0);
  await sleep(500);
  assert.match(plain(wizard.render(80)).join("\n"), /Title a/, "the dissolve has finished");
});

test("the splash moves on by itself when its time is up", async () => {
  const { wizard } = makeWizard([simpleStep("a", [])], { splash: true, splashMs: 30 });
  await sleep(120);
  assert.equal(wizard.currentStep, 0);
  wizard.dispose();
});

test("runSetupWizard is a full-screen overlay, and does nothing without a TUI", async () => {
  let options: { overlay?: boolean; overlayOptions?: unknown } | undefined;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom: (factory: (...args: unknown[]) => SetupWizard, opts: typeof options) =>
        new Promise((resolve) => {
          options = opts;
          const wizard = factory({ terminal: { rows: 24 }, requestRender: () => {} }, theme, {}, resolve);
          wizard.handleInput("\x03");
        }),
    },
  } as unknown as ExtensionContext;
  assert.equal(await runSetupWizard(ctx, [simpleStep("a", [])], { splash: false }), "cancelled");
  assert.equal(options?.overlay, true);
  assert.deepEqual(options?.overlayOptions, { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" });
  const none = { hasUI: false, mode: "print", ui: {} } as unknown as ExtensionContext;
  assert.equal(await runSetupWizard(none, [simpleStep("a", [])]), null);
});

test("maskKey shows the ends of a key and hides the middle", () => {
  assert.equal(maskKey("nsk_abcdefghijkl1234"), "nsk_••••••••••••1234");
  assert.equal(maskKey("short"), "•••••");
  assert.ok(maskKey(`nsk_${"x".repeat(200)}`).length <= 32);
});

function keyHarness(check: KeyCheck, existingKey: string | null = null, saveError: string | null = null) {
  const h = stepHarness();
  const outcomes: KeyOutcome[] = [];
  const verified: string[] = [];
  const saved: string[] = [];
  const step = keyStep({
    existingKey,
    dashboardUrl: "https://nusagate.com/dashboard",
    verify: async (key) => (verified.push(key), check),
    save: async (key) => (saved.push(key), saveError),
    onOutcome: (o) => outcomes.push(o),
  }).create(h.host);
  const type = (text: string) => step.handleInput(`\x1b[200~${text}\x1b[201~`);
  return { ...h, step, outcomes, verified, saved, type };
}

test("a pasted key is masked, checked, saved, and the step moves on after the confirmation", async () => {
  const k = keyHarness({ status: "ok", balanceIdr: 52_000 });
  k.type("nsk_live_secret_1234");
  assert.doesNotMatch(body(k.step), /live_secret/, "the key is never shown whole");
  assert.match(body(k.step), /nsk_•+1234/);
  k.step.handleInput(ENTER);
  await sleep(0);
  assert.deepEqual(k.verified, ["nsk_live_secret_1234"]);
  assert.deepEqual(k.saved, ["nsk_live_secret_1234"]);
  assert.deepEqual(k.outcomes, [{ kind: "saved", status: "ok", balanceIdr: 52_000 }]);
  assert.match(body(k.step), /Key accepted · balance Rp 52\.000/);
  k.step.tick?.();
  assert.deepEqual(k.results, [], "holds the confirmation for a moment");
  k.advance(1_000);
  k.step.tick?.();
  assert.deepEqual(k.results, ["done"]);
});

test("a rejected key stays on the step with an error, and nothing is saved", async () => {
  const k = keyHarness({ status: "rejected" });
  k.type("nsk_wrong");
  k.step.handleInput(ENTER);
  await sleep(0);
  assert.deepEqual(k.saved, []);
  assert.match(body(k.step), /didn't accept that key/);
  assert.deepEqual(k.results, []);
});

test("an empty key asks again, and esc skips when there is no key yet", () => {
  const k = keyHarness({ status: "ok" });
  k.step.handleInput(ENTER);
  assert.match(body(k.step), /Paste your key first/);
  k.step.handleInput(ESC);
  assert.deepEqual(k.outcomes, [{ kind: "skipped" }]);
  assert.deepEqual(k.results, ["skipped"]);
});

test("an existing key can be kept without typing anything", () => {
  const k = keyHarness({ status: "ok" }, "nsk_existing_key_9876");
  assert.match(body(k.step), /already has a NusaGate key/);
  assert.match(body(k.step), /nsk_•+9876/);
  k.step.handleInput(ENTER);
  assert.deepEqual(k.outcomes, [{ kind: "existing" }]);
  assert.deepEqual(k.results, ["done"]);
});

test("replacing an existing key opens the key box, and esc goes back", () => {
  const k = keyHarness({ status: "ok" }, "nsk_existing_key_9876");
  k.step.handleInput(DOWN);
  k.step.handleInput(ENTER);
  assert.match(body(k.step), /╭/);
  k.step.handleInput(ESC);
  assert.match(body(k.step), /Keep this key/);
  assert.deepEqual(k.results, []);
});

test("a key that can't be saved shows why", async () => {
  const k = keyHarness({ status: "ok" }, null, "auth.json could not be read");
  k.type("nsk_good_key_0000");
  k.step.handleInput(ENTER);
  await sleep(0);
  assert.match(body(k.step), /auth\.json could not be read/);
  assert.deepEqual(k.results, []);
});

const MODELS: ModelChoice[] = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", inputPer1M: 1_300, outputPer1M: 4_000, contextWindow: 1_048_576, vision: true },
  { id: "kimi-k3", name: "Kimi K3", inputPer1M: 17_000, outputPer1M: 89_000, contextWindow: 1_048_576, vision: true },
  { id: "qwen3.8-max", name: "Qwen 3.8 Max", inputPer1M: 11_800, outputPer1M: 35_500, contextWindow: 131_072 },
  { id: "glm-5", name: "GLM 5" },
];

function modelHarness(current: string | null = "deepseek-v4.1-flash", selectOk = true) {
  const h = stepHarness();
  const selected: string[] = [];
  const chosen: (ModelChoice | null)[] = [];
  const step = modelStep({
    skip: () => false,
    models: () => MODELS,
    currentId: () => current,
    select: async (id) => (selected.push(id), selectOk),
    onChosen: (c) => chosen.push(c),
  }).create(h.host);
  return { ...h, step, selected, chosen };
}

test("the model list shows context, rupiah and dollar prices, vision, and the current model", () => {
  const m = modelHarness();
  const text = body(m.step, 84);
  assert.match(text, /Model\s+Context\s+Rupiah\s+Dollars/);
  assert.match(text, /❯ DeepSeek V4\.1 Flash\s+1M\s+Rp 1\.300 \/ 4\.000\s+\$0\.072 \/ \$0\.22\s+vision current/);
  assert.match(text, /Kimi K3\s+1M\s+Rp 17\.000 \/ 89\.000\s+\$0\.94 \/ \$4\.94\s+vision/);
  assert.match(text, /Qwen 3\.8 Max\s+128K\s+Rp 11\.800 \/ 35\.500\s+\$0\.66 \/ \$1\.97\s*$/m, "no vision tag on a text-only model");
  assert.match(text, /Dollars at Rp 18\.000 = \$1/);
});

test("a narrow screen drops the dollar column first, then context", () => {
  const wide = modelColumns(MODELS, 84);
  assert.match(wide.header, /Context.*Rupiah.*Dollars/);
  const middle = modelColumns(MODELS, 70);
  assert.match(middle.header, /Context.*Rupiah/);
  assert.doesNotMatch(middle.header, /Dollars/);
  const narrow = modelColumns(MODELS, 50);
  assert.doesNotMatch(narrow.header, /Context|Dollars/);
  assert.match(narrow.header, /Rupiah/);
});

test("context windows read the way people say them", () => {
  assert.equal(contextLabel(1_048_576), "1M");
  assert.equal(contextLabel(1_050_000), "1M");
  assert.equal(contextLabel(2_000_000), "2M");
  assert.equal(contextLabel(272_000), "272K");
  assert.equal(contextLabel(131_072), "128K");
});

test("typing filters the models, and enter switches to the highlighted one", async () => {
  const m = modelHarness();
  for (const char of "kimi") m.step.handleInput(char);
  const text = body(m.step);
  assert.match(text, /Filter: kimi/);
  assert.doesNotMatch(text, /DeepSeek/);
  m.step.handleInput(ENTER);
  await sleep(0);
  assert.deepEqual(m.selected, ["kimi-k3"]);
  assert.equal(m.chosen[0]?.id, "kimi-k3");
  assert.deepEqual(m.results, ["done"]);
});

test("esc clears the filter first, then keeps the current model", () => {
  const m = modelHarness();
  m.step.handleInput("z");
  m.step.handleInput(ESC);
  assert.doesNotMatch(body(m.step), /Filter:/);
  m.step.handleInput(ESC);
  assert.deepEqual(m.chosen, [null]);
  assert.deepEqual(m.results, ["skipped"]);
});

test("a model that won't switch stays on the step with an error", async () => {
  const m = modelHarness("deepseek-v4.1-flash", false);
  m.step.handleInput(DOWN);
  m.step.handleInput(ENTER);
  await sleep(0);
  assert.match(body(m.step), /Couldn't switch to Kimi K3/);
  assert.deepEqual(m.results, []);
});

test("a long model list scrolls to keep the cursor in view", () => {
  const h = stepHarness();
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}` }));
  const step = modelStep({ skip: () => false, models: () => many, currentId: () => null, select: async () => true, onChosen: () => {} }).create(h.host);
  for (let i = 0; i < 20; i++) step.handleInput(DOWN);
  const text = body(step, 70, 10);
  assert.match(text, /❯ Model 20/);
  assert.match(text, /↓ \d+ more/);
  assert.ok(step.render(70, 10).length <= 10);
});

test("import picks every source by default, and space unpicks one", () => {
  const h = stepHarness();
  const runs: string[][] = [];
  const step = importStep({
    sources: [
      { label: "Claude Code", skills: ["alpha", "beta"], instructions: "CLAUDE.md" },
      { label: "Codex", skills: ["gamma"], instructions: null },
    ],
    run: (labels) => {
      runs.push(labels);
      return [{ label: "Claude Code", imported: ["alpha", "beta"], skipped: [], instructions: true }];
    },
    onImported: () => {},
  }).create(h.host);
  const text = body(step, 100);
  assert.match(text, /\[x\] Claude Code\s+2 skills · CLAUDE\.md/);
  assert.match(text, /Skills: alpha, beta/);
  assert.match(text, /API keys and MCP servers stay behind/);
  step.handleInput(DOWN);
  step.handleInput(" ");
  assert.match(body(step), /\[ \] Codex/);
  step.handleInput(ENTER);
  assert.deepEqual(runs, [["Claude Code"]]);
  assert.match(body(step), /Imported 2 skills and global instructions from Claude Code/);
  h.advance(2_000);
  step.tick?.();
  assert.deepEqual(h.results, ["done"]);
});

test("importing nothing picked counts as skipping", () => {
  const h = stepHarness();
  let ran = false;
  const step = importStep({
    sources: [{ label: "Codex", skills: ["gamma"], instructions: null }],
    run: () => ((ran = true), []),
    onImported: () => {},
  }).create(h.host);
  step.handleInput(" ");
  step.handleInput(ENTER);
  assert.equal(ran, false);
  assert.deepEqual(h.results, ["skipped"]);
});

test("importHeadline and the summary say what setup did", () => {
  assert.equal(importHeadline([]), null);
  assert.equal(
    importHeadline([
      { label: "Claude Code", imported: ["a"], skipped: [], instructions: false },
      { label: "Codex", imported: [], skipped: ["b"], instructions: false },
    ]),
    "Imported 1 skill from Claude Code",
  );
  assert.deepEqual(
    summaryLines({
      key: { kind: "saved", status: "ok", balanceIdr: 10_000 },
      model: { name: "Kimi K3", chosen: true },
      imports: [{ label: "Codex", imported: ["a", "b"], skipped: [], instructions: false }],
    }),
    [
      { tone: "success", text: "Connected to NusaGate · balance Rp 10.000" },
      { tone: "success", text: "Default model: Kimi K3" },
      { tone: "success", text: "Imported 2 skills from Codex (loads next session)" },
    ],
  );
  assert.equal(summaryLines({ key: { kind: "skipped" }, model: null, imports: null })[0]?.tone, "warning");
});

test("the closing screen lands row by row, and enter finishes", () => {
  const h = stepHarness();
  const step = readyStep(() => ({ key: { kind: "existing" }, model: null, imports: null })).create(h.host);
  assert.equal(step.render(70, 20).length, 1, "one row on the first frame");
  assert.equal(step.animating?.(), true);
  h.advance(2_000);
  const text = body(step);
  assert.match(text, /✓ Using your NusaGate key/);
  assert.match(text, /Good to know/);
  assert.match(text, /\/usage/);
  assert.equal(step.animating?.(), false);
  step.handleInput(ENTER);
  assert.deepEqual(h.results, ["done"]);
});


function languageHarness(current: string | null = null, saveError: string | null = null) {
  const h = stepHarness();
  const saved: string[] = [];
  const chosen: string[] = [];
  const previewed: string[] = [];
  const step = languageStep({
    languages: LANGUAGES,
    current,
    fallback: "en",
    preview: (id) => {
      previewed.push(id);
      setLocale(id as "en" | "id");
    },
    save: (id) => (saved.push(id), saveError),
    onChosen: (c) => chosen.push(c.id),
  }).create(h.host);
  return { ...h, step, saved, chosen, previewed };
}

test("the language step starts on English and shows each language in its own words", (t) => {
  t.after(() => setLocale("en"));
  const l = languageHarness();
  const text = body(l.step, 100);
  assert.match(text, /❯ English\s+Welcome!/);
  assert.match(text, /Bahasa Indonesia\s+Selamat datang!/);
  assert.equal(l.step.title, "Choose your language");
});

test("moving to a language redraws the step in it, and enter saves it", (t) => {
  t.after(() => setLocale("en"));
  const l = languageHarness();
  l.step.handleInput(DOWN);
  assert.deepEqual(l.previewed, ["en", "id"]);
  assert.equal(locale(), "id");
  assert.equal(l.step.title, "Pilih bahasa");
  assert.match(l.step.hints(), /pindah/);
  l.step.handleInput(ENTER);
  assert.deepEqual(l.saved, ["id"]);
  assert.deepEqual(l.chosen, ["id"]);
  assert.deepEqual(l.results, ["done"]);
});

test("the language step starts on the saved language and marks it, and number keys jump", (t) => {
  t.after(() => setLocale("en"));
  const l = languageHarness("id");
  assert.match(body(l.step, 100), /❯ Bahasa Indonesia.*saat ini/);
  l.step.handleInput("1");
  assert.equal(locale(), "en");
  l.step.handleInput(ENTER);
  assert.deepEqual(l.saved, ["en"]);
});

test("a language that can't be saved stays on the step with the reason", (t) => {
  t.after(() => setLocale("en"));
  const l = languageHarness(null, "disk full");
  l.step.handleInput(ENTER);
  assert.match(body(l.step), /disk full/);
  assert.deepEqual(l.results, []);
});

test("the whole wizard frame follows the language, step labels included", async (t) => {
  t.after(() => setLocale("en"));
  const steps = [
    languageStep({ languages: LANGUAGES, current: null, fallback: "en", preview: (id) => setLocale(id as "en" | "id"), save: () => null, onChosen: () => {} }),
    readyStep(() => ({ key: { kind: "skipped" }, model: null, imports: null })),
  ];
  const { wizard } = makeWizard(steps);
  assert.match(plain(wizard.render(80)).join("\n"), /step 1 of 2[\s\S]*● Language ── ○ Ready[\s\S]*ctrl\+c exit setup/);
  wizard.handleInput(DOWN);
  const indonesian = plain(wizard.render(80)).join("\n");
  assert.match(indonesian, /● Bahasa ── ○ Siap/);
  assert.match(indonesian, /langkah 1 dari 2/);
  assert.match(indonesian, /Pilih bahasa/);
  assert.match(indonesian, /ctrl\+c keluar/);
  wizard.handleInput(ENTER);
  await sleep(400);
  const ready = plain(wizard.render(80)).join("\n");
  assert.match(ready, /Semua sudah siap/);
  wizard.dispose();
});

test("the summary names the language NusaCode is in", (t) => {
  t.after(() => setLocale("en"));
  assert.deepEqual(summaryLines({ language: "Bahasa Indonesia", key: null, model: null, imports: null }), [
    { tone: "success", text: "NusaCode is in Bahasa Indonesia" },
  ]);
  setLocale("id");
  assert.deepEqual(summaryLines({ language: "Bahasa Indonesia", key: { kind: "saved", status: "ok", balanceIdr: 5_000 }, model: null, imports: null }), [
    { tone: "success", text: "NusaCode memakai Bahasa Indonesia" },
    { tone: "success", text: "Terhubung ke NusaGate · saldo Rp 5.000" },
  ]);
});
