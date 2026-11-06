import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIRM_IDR,
  NOTICE_TOKENS,
  confirmThreshold,
  describeEstimate,
  describeFanOut,
  estimateRequest,
  estimateTokens,
} from "../lib/estimate.ts";
import estimate from "../extensions/estimate.ts";
import { CATALOG_CHANNEL, COST_CHANNEL, type CostEvent } from "../extensions/meter.ts";

test("a token is about four characters, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("the estimate covers reading the message and re-reading the conversation from the cache", () => {
  // Rp 4.000 per 1M input, cache hits at 10%.
  const price = { inputPer1M: 4000, cachePercent: 10 };
  const result = estimateRequest(price, 100_000, 500_000);
  assert.equal(result.messageIdr, 400);
  assert.equal(result.contextIdr, 200);
  assert.equal(result.totalIdr, 600);
  assert.equal(estimateRequest(price, 10, null).contextIdr, 0, "an unknown context adds nothing");
  assert.equal(estimateRequest(price, 10, null).totalIdr, 1, "rounded up like the invoice");
});

test("the notice line says what it covers, and leaves out a cache line when there is no context", () => {
  const price = { inputPer1M: 4000, cachePercent: 10 };
  assert.equal(
    describeEstimate(estimateRequest(price, 100_000, 500_000)),
    "Large message: about 100.0k tokens, around Rp 600 to send (Rp 400 to read it + Rp 200 to re-read the conversation from the cache), before the reply.",
  );
  assert.equal(
    describeEstimate(estimateRequest(price, 6000, null)),
    "Large message: about 6.0k tokens, around Rp 24 to send (Rp 24 to read it), before the reply.",
  );
});

test("the confirmation threshold can be changed or turned off", () => {
  assert.equal(confirmThreshold(undefined), DEFAULT_CONFIRM_IDR);
  assert.equal(confirmThreshold(""), DEFAULT_CONFIRM_IDR);
  assert.equal(confirmThreshold("2k"), 2000);
  assert.equal(confirmThreshold("Rp 1.500"), 1500);
  assert.equal(confirmThreshold("off"), null);
  assert.equal(confirmThreshold("0"), null);
  assert.equal(confirmThreshold("nonsense"), DEFAULT_CONFIRM_IDR);
});

test("a fan-out total is the average run times the count", () => {
  assert.equal(
    describeFanOut(3, 40.2),
    "Starting 3 subagents at once. Subagents have cost about Rp 41 each so far in this session, so around Rp 121 in total.",
  );
});

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The extension against a fake pi, with a catalog of one model priced at Rp 4.000 per 1M input. */
function harness(options: { model?: { provider: string; id: string }; context?: number | null; hasUI?: boolean; confirm?: boolean } = {}) {
  const handlers: Record<string, Handler> = {};
  const bus: Record<string, (data: unknown) => void> = {};
  const notes: string[] = [];
  const questions: { title: string; message: string }[] = [];
  let editor = "";
  const ctx = {
    model: options.model ?? { provider: "nusagate", id: "m" },
    hasUI: options.hasUI ?? true,
    getContextUsage: () => (options.context === undefined ? { tokens: 500_000 } : options.context === null ? { tokens: null } : { tokens: options.context }),
    ui: {
      notify: (message: string) => notes.push(message),
      confirm: async (title: string, message: string) => {
        questions.push({ title, message });
        return options.confirm ?? true;
      },
      setEditorText: (text: string) => {
        editor = text;
      },
    },
  };
  estimate({
    on: (name: string, fn: Handler) => {
      handlers[name] = fn;
    },
    events: { on: (channel: string, fn: (data: unknown) => void) => (bus[channel] = fn) },
  } as unknown as ExtensionAPI);
  bus[CATALOG_CHANNEL]([{ id: "m", pricing: { inputPer1M: 4000, outputPer1M: 12000, cachePricePercent: 10 } }]);
  const cost = (costIdr: number, source: CostEvent["source"] = "subagent") =>
    bus[COST_CHANNEL]({ provider: "nusagate", model: "m", costIdr, sessionIdr: costIdr, unpriced: false, freshInput: 0, cacheRead: 0, output: 0, source });
  return {
    notes,
    questions,
    cost,
    get editor() {
      return editor;
    },
    send: (text: string, extra: Record<string, unknown> = {}) => handlers.input({ text, ...extra }, ctx) as Promise<{ action: string }>,
    assistant: (...tools: string[]) =>
      handlers.message_end({ message: { role: "assistant", content: tools.map((name) => ({ type: "toolCall", name })) } }, ctx),
    start: () => handlers.session_start({}, ctx),
    /** A task call's result: finished, or blocked / failed. */
    finished: (isError = false) => handlers.tool_result({ toolName: "task", isError }, ctx),
  };
}

const chars = (tokens: number) => "x".repeat(tokens * 4);

test("small messages pass without a word", async () => {
  const h = harness();
  assert.equal((await h.send(chars(NOTICE_TOKENS - 1))).action, "continue");
  assert.deepEqual(h.notes, []);
  assert.deepEqual(h.questions, []);
});

test("a large but cheap message gets a notice, not a question", async () => {
  const h = harness({ context: 0 });
  // 6.000 tokens at Rp 4.000 per 1M is Rp 24, far under the default Rp 500.
  assert.equal((await h.send(chars(6000))).action, "continue");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /Large message: about 6\.0k tokens, around Rp 24/);
  assert.equal(h.questions.length, 0);
});

test("a message that costs a lot to send is held until you say yes", async () => {
  // 300k tokens at Rp 4.000 per 1M is Rp 1.200 to read, plus Rp 200 for the context.
  const yes = harness({ confirm: true });
  assert.equal((await yes.send(chars(300_000))).action, "continue");
  assert.match(yes.questions[0].message, /around Rp 1\.400 to send/);
  assert.match(yes.questions[0].message, /NUSACODE_CONFIRM_ABOVE=off/);
  assert.equal(yes.notes.length, 0, "the question replaces the notice");

  const no = harness({ confirm: false });
  const text = chars(300_000);
  assert.equal((await no.send(text)).action, "handled");
  assert.equal(no.editor, text, "the text goes back in the box");
});

test("the threshold can be raised, or the question turned off, from the environment", async (t) => {
  const previous = process.env.NUSACODE_CONFIRM_ABOVE;
  t.after(() => {
    if (previous === undefined) delete process.env.NUSACODE_CONFIRM_ABOVE;
    else process.env.NUSACODE_CONFIRM_ABOVE = previous;
  });
  process.env.NUSACODE_CONFIRM_ABOVE = "5k";
  const raised = harness();
  assert.equal((await raised.send(chars(300_000))).action, "continue");
  assert.equal(raised.questions.length, 0);
  assert.equal(raised.notes.length, 1, "still told, just not asked");

  process.env.NUSACODE_CONFIRM_ABOVE = "off";
  const off = harness();
  await off.send(chars(300_000));
  assert.equal(off.questions.length, 0);
});

test("a queued message, a screenless run and an unpriced model are never asked about", async () => {
  const queued = harness();
  assert.equal((await queued.send(chars(300_000), { streamingBehavior: "steer" })).action, "continue");
  assert.equal(queued.questions.length, 0);
  assert.equal(queued.notes.length, 1);

  const noScreen = harness({ hasUI: false });
  assert.equal((await noScreen.send(chars(300_000))).action, "continue");
  assert.equal(noScreen.questions.length, 0);

  const other = harness({ model: { provider: "mine", id: "m" } });
  assert.equal((await other.send(chars(300_000))).action, "continue");
  assert.deepEqual(other.notes, []);
  const unknown = harness({ model: { provider: "nusagate", id: "not-in-catalog" } });
  assert.equal((await unknown.send(chars(300_000))).action, "continue");
  assert.deepEqual(unknown.notes, []);
});

test("an unknown context size just leaves the cache part out", async () => {
  const h = harness({ context: null, confirm: true });
  await h.send(chars(6000));
  assert.doesNotMatch(h.notes[0], /re-read/);
});

test("a fan-out is priced from the subagents that finished, and never before there is any evidence", () => {
  const h = harness();
  h.assistant("task", "task"); // nothing has finished yet
  assert.deepEqual(h.notes, []);
  h.cost(60);
  h.cost(30, "subagent");
  h.cost(999, "main"); // the main agent's own spending is not a subagent's
  h.finished();
  h.finished();
  h.assistant("read"); // not a task
  h.assistant("task"); // one on its own: no total needed
  assert.deepEqual(h.notes, []);
  // 2 finished, Rp 90 spent: Rp 45 each. The lone task above hasn't finished, so it doesn't count.
  h.assistant("task", "task", "task");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /Starting 3 subagents at once\. Subagents have cost about Rp 45 each.*around Rp 135 in total/);
});

test("blocked or failed subagent calls don't drag the average down", () => {
  const h = harness();
  h.finished(true); // blocked by plan mode
  h.finished(true); // blocked by the budget
  h.finished(true); // unknown agent
  h.cost(300);
  h.finished();
  h.assistant("task", "task", "task", "task");
  assert.match(h.notes[0], /about Rp 300 each.*around Rp 1\.200 in total/);
});

test("a new session starts the subagent average over", () => {
  const h = harness();
  h.cost(100);
  h.finished();
  h.start();
  h.assistant("task", "task");
  assert.deepEqual(h.notes, []);
});
