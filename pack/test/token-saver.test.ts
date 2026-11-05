import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** MAX_LINES is a module-level const: every scenario re-imports with a cache-busting query. */
const mod = (query: string) => import(`../extensions/token-saver.ts?${query}`);

function harness(register: (pi: unknown) => void) {
  const handlers: Record<string, Handler> = {};
  const notifications: string[] = [];
  const pi = {
    on(name: string, fn: Handler) {
      handlers[name] = fn;
    },
    getSettings: () => ({}),
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
    events: { on: () => {} },
  };
  const ctx = { ui: { notify: (message: string) => notifications.push(message) } };
  register(pi as unknown as ExtensionAPI);
  return { handlers, ctx, notifications };
}

const readEvent = (text: string, offset?: number, extras: object = {}) => ({
  toolName: "read",
  isError: false,
  content: [{ type: "text", text }],
  input: offset === undefined ? {} : { offset },
  structuredContent: { key: "value" },
  ...extras,
});

/** Sets env for a dynamic import and restores both vars afterwards. */
async function loadWith(t: { after: (fn: () => void) => void }, env: Record<string, string>, query: string) {
  const saved = { NUSACODE_TRUNCATE_LINES: process.env.NUSACODE_TRUNCATE_LINES, NUSACODE_NO_TOKEN_SAVER: process.env.NUSACODE_NO_TOKEN_SAVER };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return (await mod(query)).default;
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("read at or under the cap passes through untouched", async (t) => {
  const { handlers } = harness(await loadWith(t, { NUSACODE_TRUNCATE_LINES: "3" }, "ts-under"));
  assert.equal(handlers.tool_result(readEvent("a\nb\nc")), undefined);
  assert.equal(handlers.tool_result(readEvent(lines(3))), undefined);
});

test("read over the cap keeps N lines and points at start + N, with and without offset", async (t) => {
  const { handlers } = harness(await loadWith(t, { NUSACODE_TRUNCATE_LINES: "3" }, "ts-read"));
  const result = handlers.tool_result(readEvent(lines(5))) as { content: { text: string }[] };
  assert.ok(result, "over-cap read must be replaced");
  assert.equal(result.content[0].text, "line 1\nline 2\nline 3\n\n[dipotong: 3 dari 5 baris; lanjut: offset 4]");
  const continued = handlers.tool_result(readEvent(lines(5), 50)) as { content: { text: string }[] };
  assert.ok(continued, "offset 50 must still truncate");
  // The off-by-one: the next offset continues at 50 + N, never resets to 1 + N.
  assert.match(continued.content[0].text, /lanjut: offset 53\]$/);
  assert.doesNotMatch(continued.content[0].text, /offset 4\]/);
});

test("bash over the cap keeps the tail with exact hidden-count header", async (t) => {
  const { handlers } = harness(await loadWith(t, { NUSACODE_TRUNCATE_LINES: "3" }, "ts-bash"));
  const event = { ...readEvent(lines(5)), toolName: "bash", input: {} };
  const result = handlers.tool_result(event) as { content: { text: string }[] };
  assert.ok(result, "over-cap bash must be replaced");
  assert.equal(result.content[0].text, "[dipotong: 2 baris awal; menampilkan 3-5 dari 5]\nline 3\nline 4\nline 5");
});

test("errors and other tools pass through untouched", async (t) => {
  const { handlers } = harness(await loadWith(t, { NUSACODE_TRUNCATE_LINES: "3" }, "ts-passthrough"));
  const long = lines(10);
  assert.equal(handlers.tool_result(readEvent(long, undefined, { isError: true })), undefined);
  assert.equal(handlers.tool_result({ ...readEvent(long), toolName: "grep" }), undefined);
});

test("replacement echoes details and structuredContent back", async (t) => {
  const { handlers } = harness(await loadWith(t, { NUSACODE_TRUNCATE_LINES: "3" }, "ts-echo"));
  const details = { file: "/tmp/x" };
  const structured = { total: 5 };
  const result = handlers.tool_result(readEvent(lines(5), undefined, { details, structuredContent: structured })) as {
    details: unknown;
    structuredContent: unknown;
  };
  // pi drops structured content when content is replaced without echoing it back.
  assert.equal(result.details, details);
  assert.equal(result.structuredContent, structured);
});

test("NUSACODE_NO_TOKEN_SAVER=1 registers nothing at all", async (t) => {
  const register = await loadWith(t, { NUSACODE_NO_TOKEN_SAVER: "1" }, "ts-off");
  const { handlers } = harness(register);
  assert.deepEqual(Object.keys(handlers), []);
});

test("cache-prefix warning fires exactly once per change", async (t) => {
  const register = await loadWith(t, {}, "ts-warn");
  const { handlers, ctx, notifications } = harness(register);
  const warning = "cache prefix changed, input cost may rise ~10x";
  const payload = (system: string, tools: unknown[] = []) => ({ payload: { system, tools } });

  handlers.before_provider_request(payload("alpha"), ctx);
  assert.equal(notifications.length, 0, "first request has no previous prefix, never warns");

  handlers.before_provider_request(payload("beta"), ctx);
  assert.deepEqual(notifications, [warning]);

  handlers.before_provider_request(payload("beta"), ctx);
  assert.equal(notifications.length, 1, "same prefix must not warn again");

  // A schema edit changes the fingerprint even with identical tool names.
  handlers.before_provider_request({ payload: { system: "beta", tools: [{ name: "read", function: { name: "read" }, x: 1 }] } }, ctx);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1], warning);
});
