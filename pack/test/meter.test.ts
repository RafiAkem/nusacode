import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import meter, { SUMMARY_CHANNEL, type SummaryRow } from "../extensions/meter.ts";

const DEFAULT_MODELS_URL = "https://api.nusagate.com/api/public/models";
/** The wallet row, normalized like costLine so column padding does not matter. */
const saldoLine = (report: string) =>
  (report.split("\n").find((line) => line.startsWith("Saldo ")) as string).replace(/^Saldo\s+/, "Saldo ");

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
    start: () => handlers.session_start({}, ctx),
    respond: (model: string, usage: Usage) =>
      handlers.message_end(
        { message: { role: "assistant", provider: "nusagate", model, usage: { cacheRead: 0, cacheWrite: 0, ...usage } } },
        ctx,
      ),
    /** The /usage command is the report surface; agent_end also notifies once requests > 0. */
    report: async () => {
      await commands.usage("", ctx);
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
  (report.split("\n").find((line) => line.startsWith("Biaya sesi ")) as string).replace(/^Biaya sesi\s+/, "Biaya sesi ");

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
  await h.handlers.agent_end({}, h.ctx);

  assert.equal(
    h.notifications.at(-1),
    [
      "NusaCode · nusagate/test-model",
      "─".repeat(32),
      "Request     1 request",
      "Token       375.0k · input 150.0k · cache 200.0k · output 25.0k",
      "Cache hit   █████████░░░░░░░ 57.1%",
      "Biaya sesi  Rp 660",
      `Harga: ${DEFAULT_MODELS_URL} (fetch sekali saat session_start)`,
      "Saldo       Rp 250.000",
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

  assert.equal(costLine(await h.report()), "Biaya sesi Rp 2");

  // A single 1.2 rupiah response must bill Rp 2, not Rp 1.
  await h.start();
  h.respond("cheap", { input: 600_000, output: 0 });
  assert.equal(costLine(await h.report()), "Biaya sesi Rp 2");
});

test("derives the cache percentage from cachePricePer1M when cachePricePercent is absent", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("derived", { inputPer1M: 1000, outputPer1M: 1000, cachePricePer1M: 100 })));
  const h = harness();
  await h.start();

  // 1M cached tokens at 100/1M = 10% of the 1000/1M input price -> Rp 100.
  h.respond("derived", { input: 0, cacheRead: 1_000_000, output: 0 });

  assert.equal(costLine(await h.report()), "Biaya sesi Rp 100");
});

test("bills cached tokens at the full input price when the catalog has no cache price", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("nocache", { inputPer1M: 1000, outputPer1M: 1000 })));
  const h = harness();
  await h.start();

  h.respond("nocache", { input: 0, cacheRead: 1_000_000, output: 0 });

  assert.equal(costLine(await h.report()), "Biaya sesi Rp 1.000");
});

test("flags an unpriced model as a lower bound instead of billing it at zero", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000, cachePricePercent: 10 })));
  const h = harness();
  await h.start();

  h.respond("test-model", { input: 100_000, cacheRead: 200_000, cacheWrite: 50_000, output: 25_000 });
  h.respond("ghost-model", { input: 1_000, output: 0 });

  const report = await h.report();
  assert.equal(costLine(report), "Biaya sesi Rp 660");
  assert.match(report, /^1 respons tanpa harga \(model tidak ada di katalog\)$/m);
  assert.equal(h.statuses.at(-1), "nusa · ≥ Rp 660 · 376.0k tok");
});

test("survives a non-ok price catalog and reports price unavailable", async (t) => {
  restoreFetch(t);
  stubFetch(null, { ok: false, status: 503 });
  const h = harness();

  await h.start(); // must not throw
  assert.equal(h.statuses.at(-1), "nusa · harga tidak tersedia");
  assert.match(await h.report(), /^Biaya tidak tersedia \(fetch harga gagal: HTTP 503\)$/m);

  // A later session_start with a good catalog bills again.
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000, cachePricePercent: 10 })));
  await h.start();
  h.respond("test-model", { input: 100_000, cacheRead: 200_000, cacheWrite: 50_000, output: 25_000 });
  assert.equal(costLine(await h.report()), "Biaya sesi Rp 660");
});

test("survives a catalog with no usable price rows", async (t) => {
  restoreFetch(t);
  stubFetch({ data: [{ id: "no-pricing" }] });
  const h = harness();

  await h.start(); // must not throw
  assert.match(await h.report(), /^Biaya tidak tersedia \(fetch harga gagal: no model prices in response\)$/m);
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
  assert.match(await h.report(), /^Harga: https:\/\/prices\.test\/models \(fetch sekali saat session_start\)$/m);
});

test("reports an empty session without a request table", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })));
  const h = harness();
  await h.start();

  assert.deepEqual((await h.report()).split("\n").slice(2, 4), ["Belum ada pemakaian di sesi ini.", `Harga: ${DEFAULT_MODELS_URL} (fetch sekali saat session_start)`]);
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
  assert.equal(saldoLine(report), "Saldo Rp 3.992.912");
  assert.match(report, /^Pass\s+Rp 487\.758 sisa dari Rp 500\.000 · s\/d 2026-11-30$/m);
});

test("adds the topup link when the balance runs low", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })), { balance: { balance: 4_000 } });
  const h = harness();
  await h.start();

  assert.match(await h.report(), /^Saldo menipis · top up: https:\/\/nusagate\.com\/dashboard\/wallet\?src=cli&key=nsk_abcdefg$/m);
});

test("keeps billing when the balance endpoint fails", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })), { balanceStatus: 503 });
  const h = harness();
  await h.start();

  h.respond("test-model", { input: 1_000_000, output: 0 });

  const report = await h.report();
  assert.equal(costLine(report), "Biaya sesi Rp 3.000");
  assert.equal(saldoLine(report), "Saldo tidak tersedia (HTTP 503)");
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
    { label: "Saldo", value: "memuat...", warn: false },
    { label: "Harga", value: "memuat..." },
  ]);
  assert.deepEqual(h.summaries.at(-1), [
    { label: "Saldo", value: "Rp 250.000", warn: false },
    { label: "Pass", value: "Rp 487.758 sisa dari Rp 500.000 · s/d 2026-11-30" },
    { label: "Harga", value: "Rp 3.000 input · Rp 6.000 output /1M" },
    { label: "Hemat", value: "75.0% dari harga resmi" },
  ]);
});

test("startup summary flags a low balance and a failed wallet fetch", async (t) => {
  restoreFetch(t);
  const prices = catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 }));

  stubFetch(prices, { balance: { balance: 4_000 } });
  const low = harness();
  await low.start();
  assert.deepEqual(low.summaries.at(-1)?.[0], { label: "Saldo", value: "Rp 4.000 · menipis, /topup", warn: true });

  stubFetch(prices, { balanceStatus: 503 });
  const failed = harness();
  await failed.start();
  assert.deepEqual(failed.summaries.at(-1)?.[0], { label: "Saldo", value: "tidak tersedia (HTTP 503)", warn: true });
});

test("/topup reports the balance next to the link", async (t) => {
  restoreFetch(t);
  stubFetch(catalog(priceRow("test-model", { inputPer1M: 3000, outputPer1M: 6000 })));
  const h = harness();
  await h.start();

  await h.topup();

  assert.equal(
    h.notifications.at(-1),
    "Saldo: Rp 250.000\nTop up: https://nusagate.com/dashboard/wallet?src=cli&key=nsk_abcdefg",
  );
});
