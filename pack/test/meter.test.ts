import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import meter, { COST_CHANNEL, SUMMARY_CHANNEL, type CostEvent, type SummaryRow, billedCost } from "../extensions/meter.ts";
import { LOG_FILE, appendRecord } from "../lib/usage-log.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The report reads the saved spending history, so these tests need a home of their own.
const home = mkdtempSync(join(tmpdir(), "nusacode-meter-"));
process.env.NUSACODE_CODING_AGENT_DIR = home;
test.after(() => rmSync(home, { recursive: true, force: true }));

const DEFAULT_MODELS_URL = "https://api.nusagate.com/api/public/models";
/** The wallet row, normalized like costLine so column padding does not matter. */
const balanceLine = (report: string) =>
  (report.split("\n").find((line) => line.startsWith("Balance ")) as string).replace(/^Balance\s+/, "Balance ");

type Usage = { input: number; cacheRead?: number; cacheWrite?: number; output: number };
type Ctx = {
  ui: { notify(message: string): void; setStatus(key: string, text: string): void };
  modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
};
type Handler = (event: unknown, ctx: Ctx) => unknown;

const priceRow = (id: string, pricing: Record<string, number>) => ({ id, pricing });
const catalog = (...rows: unknown[]) => ({ data: rows });

/** Records the meter's registered handlers and its notify/setStatus output. */
function harness() {
  const handlers: Record<string, Handler> = {};
  const commands: Record<string, (args: string, ctx: Ctx) => unknown> = {};
  const notifications: string[] = [];
  const statuses: string[] = [];
  const summaries: SummaryRow[][] = [];
  const costEvents: CostEvent[] = [];
  const pi = {
    on(name: string, fn: Handler) {
      handlers[name] = fn;
    },
    registerCommand(name: string, def: { handler: (args: string, ctx: Ctx) => unknown }) {
      commands[name] = def.handler;
    },
    events: {
      on: () => {},
      emit(channel: string, data: unknown) {
        if (channel === SUMMARY_CHANNEL) summaries.push((data as { rows: SummaryRow[] }).rows);
        if (channel === COST_CHANNEL) costEvents.push(data as CostEvent);
      },
    },
    getSettings: () => ({}),
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  };
  const ctx: Ctx = {
    ui: {
      notify(message) {
        notifications.push(message);
      },
      setStatus(_key, text) {
        statuses.push(text);
      },
    },
    modelRegistry: { getApiKeyForProvider: async () => "nsk_abcdefghijkl" },
  };
  // Only the surface the meter touches is implemented; the rest of ExtensionAPI is unused.
  meter(pi as unknown as ExtensionAPI);
  return {
    ctx,
    handlers,
    notifications,
    statuses,
    summaries,
    costEvents,
    start: () => handlers.session_start({}, ctx),
    /** A raw chunk from the provider's stream, as pi hands it to provider_stream_event. */
    chunk: (data: unknown, provider = "nusagate") => handlers.provider_stream_event({ type: "provider_stream_event", provider, data }, ctx),
    request: () => handlers.before_provider_request({ type: "before_provider_request", payload: {} }, ctx),
    respond: (model: string, usage: Usage) =>
      handlers.message_end(
        { message: { role: "assistant", provider: "nusagate", model, usage: { cacheRead: 0, cacheWrite: 0, ...usage } } },
        ctx,
      ),
    /** The /usage command is the only report surface. */
    report: async () => {
      await commands.usage("", ctx);
      return notifications.at(-1) as string;
    },
    /** /usage with arguments, such as `history week`. */
    usage: async (args: string) => {
      await commands.usage(args, ctx);
      return notifications.at(-1) as string;
    },
    topup: async () => {
      await commands.topup("", ctx);
      return notifications.at(-1) as string;
    },
  };
}

const BALANCE_URL = "https://api.nusagate.com/v1/balance";
/** Default wallet response; tests override it via `stubFetch(body, { balance })`. */
const DEFAULT_BALANCE = { balance: 250_000, currency: "IDR" };

/**
 * Stubs fetch for both catalog and wallet. `body` answers the price catalog;
 * `init.balance` answers `/v1/balance` and defaults to a funded wallet.
 */
function stubFetch(
  body: unknown,
  init: { ok?: boolean; status?: number; balance?: unknown; balanceStatus?: number } = {},
) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url === BALANCE_URL) {
      const status = init.balanceStatus ?? 200;
      return { ok: status < 400, status, json: async () => init.balance ?? DEFAULT_BALANCE };
    }
    return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body };
  }) as unknown as typeof fetch;
  return calls;
}

/** The cost row, normalized so tests assert amounts rather than column padding. */
const costLine = (report: string) =>
  (report.split("\n").find((line) => line.startsWith("Session cost ")) as string).replace(/^Session cost\s+/, "Session cost ");

/** Restores globalThis.fetch after each test. */
function restoreFetch(t: { after: (fn: () => void) => void }) {
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
}

test("bills with the gateway formula: cacheWrite as fresh input, cacheRead at the cache percent", async (t) => {
  restoreFetch(t);
  const calls = stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000, cachePricePercent: 10 })));
  const h = harness();
  await h.start();
  assert.equal(calls[0], DEFAULT_MODELS_URL);

  // fresh = 100_000 input + 50_000 cacheWrite = 150_000 -> 450
  // cached = 200_000 at 10% of 3000 -> 60; output 25_000 at 6000 -> 150; total 660
  h.respond("test-model", { input: 100_000, cacheRead: 200_000, cacheWrite: 50_000, output: 25_000 });
  assert.equal(h.handlers.agent_end, undefined, "the report only appears on /usage");
  assert.deepEqual(h.notifications, []);

  assert.equal(
    await h.report(),
    [
      "NusaCode · nusagate/test-model",
      "─".repeat(32),
      "Requests      1",
      "Tokens        375.0k · input 150.0k · cache 200.0k · output 25.0k",
      "Cache hit     █████████░░░░░░░ 57.1%",
      "Session cost  Rp 660",
      `Prices: ${DEFAULT_MODELS_URL} (fetched once at session start)`,
      "Balance       Rp 250.000",
    ].join("\n"),
  );
});

test("rounds each request up separately instead of rounding the aggregate", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("cheap", { inputPer1M: 2, outputPer1M: 2 })));
  const h = harness();
  await h.start();

  // 100_000 tokens at 2/1M = 0.2 rupiah per response: ceil each -> 1 + 1 = 2.
  // Rounding the aggregate (ceil 0.4) would bill Rp 1.
  h.respond("cheap", { input: 100_000, output: 0 });
  h.respond("cheap", { input: 100_000, output: 0 });

  assert.equal(costLine(await h.report()), "Session cost Rp 2");

  // A single 1.2 rupiah response must bill Rp 2, not Rp 1.
  await h.start();
  h.respond("cheap", { input: 600_000, output: 0 });
  assert.equal(costLine(await h.report()), "Session cost Rp 2");
});

test("derives the cache percentage from cachePricePer1M when cachePricePercent is absent", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("derived", { inputPer1M: 1000, outputPer1M: 1000, cachePricePer1M: 100 })));
  const h = harness();
  await h.start();

  // 1M cached tokens at 100/1M = 10% of the 1000/1M input price -> Rp 100.
  h.respond("derived", { input: 0, cacheRead: 1_000_000, output: 0 });

  assert.equal(costLine(await h.report()), "Session cost Rp 100");
});

test("bills cached tokens at the full input price when the catalog has no cache price", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("nocache", { inputPer1M: 1000, outputPer1M: 1000 })));
  const h = harness();
  await h.start();

  h.respond("nocache", { input: 0, cacheRead: 1_000_000, output: 0 });

  assert.equal(costLine(await h.report()), "Session cost Rp 1.000");
});

test("flags an unpriced model as a lower bound instead of billing it at zero", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000, cachePricePercent: 10 })));
  const h = harness();
  await h.start();

  h.respond("test-model", { input: 100_000, cacheRead: 200_000, cacheWrite: 50_000, output: 25_000 });
  h.respond("ghost-model", { input: 1_000, output: 0 });

  const report = await h.report();
  assert.equal(costLine(report), "Session cost Rp 660");
  assert.match(report, /^1 response\(s\) without a price \(model not in catalog\)$/m);
  assert.equal(h.statuses.at(-1), "nusa · ≥ Rp 660 · 376.0k tok · cache 57.0%");
});

test("survives a non-ok price catalog and reports price unavailable", async (t) => {
  restoreFetch(t);
  stubFetch(null, { ok: false, status: 503 });
  const h = harness();

  await h.start(); // must not throw
  assert.equal(h.statuses.at(-1), "nusa · prices unavailable");
  assert.match(await h.report(), /^Cost unavailable \(price fetch failed: HTTP 503\)$/m);

  // A later session_start with a good catalog bills again.
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000, cachePricePercent: 10 })));
  await h.start();
  h.respond("test-model", { input: 100_000, cacheRead: 200_000, cacheWrite: 50_000, output: 25_000 });
  assert.equal(costLine(await h.report()), "Session cost Rp 660");
});

test("survives a catalog with no usable price rows", async (t) => {
  restoreFetch(t);
  stubFetch({ data: [{ id: "no-pricing" }] });
  const h = harness();

  await h.start(); // must not throw
  assert.match(await h.report(), /^Cost unavailable \(price fetch failed: no model prices in response\)$/m);
});

test("fetches NUSAGATE_MODELS_URL when it is set", async (t) => {
  restoreFetch(t);
  const previous = process.env.NUSAGATE_MODELS_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.NUSAGATE_MODELS_URL;
    else process.env.NUSAGATE_MODELS_URL = previous;
  });

  process.env.NUSAGATE_MODELS_URL = "https://prices.test/models";
  const calls = stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000, cachePricePercent: 10 })));
  const h = harness();
  await h.start();

  assert.equal(calls[0], "https://prices.test/models");
  h.respond("test-model", { input: 1_000_000, output: 0 });
  assert.match(await h.report(), /^Prices: https:\/\/prices\.test\/models \(fetched once at session start\)$/m);
});

test("reports an empty session without a request table", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })));
  const h = harness();
  await h.start();

  assert.deepEqual((await h.report()).split("\n").slice(2, 4), ["No usage in this session yet.", `Prices: ${DEFAULT_MODELS_URL} (fetched once at session start)`]);
});

test("shows the wallet balance and the pass quota", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })), {
    balance: {
      balance: 3_992_912,
      currency: "IDR",
      pass: { valueTotalIdr: 500_000, valueUsedIdr: 12_242, valueRemainingIdr: 487_758, endsAt: "2026-11-30T17:28:28.826Z" },
    },
  });
  const h = harness();
  await h.start();

  const report = await h.report();
  assert.equal(balanceLine(report), "Balance Rp 3.992.912");
  assert.match(report, /^Pass\s+Rp 487\.758 left of Rp 500\.000 · until 2026-11-30$/m);
});

test("adds the topup link when the balance runs low", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })), { balance: { balance: 4_000 } });
  const h = harness();
  await h.start();

  assert.match(await h.report(), /^Low balance · top up: https:\/\/nusagate\.com\/dashboard\/wallet\?src=cli&key=nsk_abcdefg$/m);
});

test("keeps billing when the balance endpoint fails", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })), { balanceStatus: 503 });
  const h = harness();
  await h.start();

  h.respond("test-model", { input: 1_000_000, output: 0 });

  const report = await h.report();
  assert.equal(costLine(report), "Session cost Rp 3.000");
  assert.equal(balanceLine(report), "Balance unavailable (HTTP 503)");
});

test("speed is timed from the first chunk and shown in the status and /usage", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })));
  t.mock.timers.enable({ apis: ["Date"] });
  const h = harness();
  await h.start();
  const reply = async (output: number, waitMs: number, streamMs: number) => {
    t.mock.timers.tick(waitMs); // Time before the first chunk must not count.
    const message = { role: "assistant" };
    for (const elapsed of [0, streamMs]) {
      t.mock.timers.tick(elapsed);
      await h.handlers.message_update({ message }, h.ctx);
    }
    h.respond("test-model", { input: 10, output });
  };

  await reply(100, 5_000, 2_000);
  assert.match(h.statuses.at(-1) as string, / · 50 tok\/s$/);

  await reply(300, 0, 3_000);
  assert.match(h.statuses.at(-1) as string, / · 100 tok\/s$/);
  assert.match(await h.report(), /^Speed\s+100 tok\/s last · 80 tok\/s average$/m);
});

test("a reply with no measurable streaming time reports no speed", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })));
  t.mock.timers.enable({ apis: ["Date"] });
  const h = harness();
  await h.start();

  await h.handlers.message_update({ message: { role: "assistant" } }, h.ctx);
  h.respond("test-model", { input: 10, output: 100 });

  assert.doesNotMatch(h.statuses.at(-1) as string, /tok\/s/);
  assert.doesNotMatch(await h.report(), /Speed/);
});

test("the list price saving ignores cached tokens, so cache hits can't inflate it", async (t) => {
  restoreFetch(t);
  // Official $1 and $2 per 1M at Rp 18.000 per USD: Rp 18.000 input and Rp 36.000 output.
  stubFetch(
    catalog(
      priceRow("test-model", {
        inputPer1M: 9_000,
        outputPer1M: 18_000,
        cachePricePercent: 10,
        officialUsdInputPer1M: 1,
        officialUsdOutputPer1M: 2,
      }),
    ),
  );
  const listPrice = async (usage: { input: number; cacheRead: number; output: number }) => {
    const h = harness();
    await h.start();
    h.respond("test-model", usage);
    return (await h.report()).split("\n").find((line) => line.startsWith("List price"));
  };
  const noCache = await listPrice({ input: 1_000_000, cacheRead: 0, output: 1_000_000 });
  const heavyCache = await listPrice({ input: 1_000_000, cacheRead: 50_000_000, output: 1_000_000 });
  assert.match(noCache as string, /Rp 54\.000 · saved 50\.0% \(excl\. cached tokens\)$/);
  assert.equal(heavyCache, noCache);
});

test("startup summary goes from loading to wallet and price rows", async (t) => {
  restoreFetch(t);
  stubFetch(
    catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000, officialUsdInputPer1M: 1, officialUsdOutputPer1M: 1 })),
    {
      balance: {
        balance: 250_000,
        pass: { valueTotalIdr: 500_000, valueRemainingIdr: 487_758, endsAt: "2026-11-30T17:28:28.826Z" },
      },
    },
  );
  const h = harness();
  (h.ctx as unknown as { model: unknown }).model = { provider: "nusagate", id: "test-model" };
  await h.start();

  assert.deepEqual(h.summaries[0], [
    { label: "Balance", value: "loading...", warn: false },
    { label: "Price", value: "loading..." },
  ]);
  assert.deepEqual(h.summaries.at(-1), [
    { label: "Balance", value: "Rp 250.000", warn: false },
    { label: "Pass", value: "Rp 487.758 left of Rp 500.000 · until 2026-11-30" },
    { label: "Price", value: "Rp 3.000 input · Rp 6.000 output /1M" },
    { label: "Saved", value: "75.0% vs list price" },
  ]);
});

test("startup summary flags a low balance and a failed wallet fetch", async (t) => {
  restoreFetch(t);
  const prices = catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 }));

  stubFetch(prices, { balance: { balance: 4_000 } });
  const low = harness();
  await low.start();
  assert.deepEqual(low.summaries.at(-1)?.[0], { label: "Balance", value: "Rp 4.000 · low, /topup", warn: true });

  stubFetch(prices, { balanceStatus: 503 });
  const failed = harness();
  await failed.start();
  assert.deepEqual(failed.summaries.at(-1)?.[0], { label: "Balance", value: "unavailable (HTTP 503)", warn: true });
});

test("/topup reports the balance next to the link", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })));
  const h = harness();
  await h.start();

  await h.topup();

  assert.equal(
    h.notifications.at(-1),
    "Balance: Rp 250.000\nTop up: https://nusagate.com/dashboard/wallet?src=cli&key=nsk_abcdefg",
  );
});

test("every response is published with its own cost and the session total", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("m", { inputPer1M: 1000, outputPer1M: 2000, cachePricePercent: 10 })));
  const h = harness();
  await h.start();
  h.respond("m", { input: 1_000_000, output: 0 });
  h.respond("m", { input: 0, output: 500_000 });
  h.respond("unpriced-model", { input: 10, output: 10 });
  assert.deepEqual(
    h.costEvents.map((e) => [e.model, e.costIdr, e.sessionIdr, e.unpriced, e.source]),
    [
      ["m", 1000, 1000, false, "main"],
      ["m", 1000, 2000, false, "main"],
      ["unpriced-model", 0, 2000, true, "main"],
    ],
  );
});

test("/usage adds today and this month from the saved history, and /usage history breaks it down", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("m", { inputPer1M: 1000, outputPer1M: 2000, cachePricePercent: 10 })));
  const h = harness();
  await h.start();
  assert.equal((await h.report()).includes("Today"), false, "no history yet, no rows");

  const now = new Date();
  const record = (model: string, cost: number) => ({ t: now.toISOString(), model, cost, fresh: 100, cached: 100, output: 10 });
  appendRecord(home, record("nusagate/m", 700));
  appendRecord(home, record("nusagate/other", 300));
  const report = await h.report();
  assert.ok(report.includes("Today         Rp 1.000 · 2 requests"), report);
  assert.ok(report.includes("This month    Rp 1.000 · 2 requests"), report);
  assert.ok(report.includes("More: /usage history"));

  const history = await h.usage("history");
  assert.ok(history.includes("usage history"));
  assert.ok(history.includes("nusagate/m  "));
  assert.ok((await h.usage("history week")).includes("By model, the last 7 days"));
  assert.ok((await h.usage("history decade")).includes("Usage: /usage history"));
  rmSync(join(home, LOG_FILE));
});

test("what NusaGate billed (usage.cost_idr) is the cost, instead of the estimate", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })));
  const h = harness();
  await h.start();
  // The estimate would be Rp 3 (1000 input tokens); the gateway billed Rp 7.
  h.request();
  h.chunk({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 0, cost_idr: 7 } });
  h.respond("test-model", { input: 1000, output: 0 });
  assert.equal(h.costEvents.at(-1)!.costIdr, 7);
  // The next response has no billed amount, so it falls back to the estimate.
  h.request();
  h.respond("test-model", { input: 1000, output: 0 });
  assert.equal(h.costEvents.at(-1)!.costIdr, 3);
  assert.equal(costLine(await h.report()), "Session cost Rp 10");
});

test("a billed cost counts even for a model missing from the price list", async (t) => {
  restoreFetch(t);
  stubFetch(catalog());
  const h = harness();
  await h.start();
  h.request();
  h.chunk({ usage: { cost_idr: 12 } });
  h.respond("brand-new-model", { input: 10, output: 10 });
  assert.equal(h.costEvents.at(-1)!.costIdr, 12);
  assert.equal(h.costEvents.at(-1)!.unpriced, false);
});

test("a billed cost from a failed request, or another provider, is never used", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })));
  const h = harness();
  await h.start();
  h.request();
  h.chunk({ usage: { cost_idr: 99 } });
  h.request(); // a retry: the first request never finished
  h.respond("test-model", { input: 1000, output: 0 });
  assert.equal(h.costEvents.at(-1)!.costIdr, 3);
  h.request();
  h.chunk({ usage: { cost_idr: 50 } }, "openai");
  h.respond("test-model", { input: 1000, output: 0 });
  assert.equal(h.costEvents.at(-1)!.costIdr, 3);
});

test("billedCost reads usage.cost_idr and nothing else", () => {
  assert.equal(billedCost({ usage: { cost_idr: 1 } }), 1);
  assert.equal(billedCost({ usage: { cost_idr: 0 } }), 0);
  assert.equal(billedCost({ usage: { cost: 0.00001 } }), null, "the dollar cost is not the rupiah bill");
  for (const bad of [{ usage: { cost_idr: -1 } }, { usage: { cost_idr: "5" } }, { usage: { cost_idr: Number.NaN } }, { choices: [] }, null, "x"]) {
    assert.equal(billedCost(bad), null);
  }
});
