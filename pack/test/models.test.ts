import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CATALOG_CHANNEL } from "../extensions/meter.ts";
import models, { parseCatalog, withoutReasoningEffort } from "../extensions/models.ts";

type Registered = { models: { id: string; name: string; contextWindow: number; maxTokens: number }[]; baseUrl: string };

/** Loads the extension against a temp home; returns its registrations and the catalog event. */
function load(t: { after(fn: () => void): void }, cache?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-models-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  if (cache !== undefined) writeFileSync(join(dir, "nusagate-models.json"), JSON.stringify(cache));
  const registered: Registered[] = [];
  let publish: (rows: unknown) => void = () => {};
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  models({
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      handlers[name] = fn;
    },
    registerProvider: (name: string, config: Registered) => {
      assert.equal(name, "nusagate");
      registered.push(config);
    },
    events: {
      on: (channel: string, fn: (rows: unknown) => void) => {
        if (channel === CATALOG_CHANNEL) publish = fn;
      },
    },
  } as unknown as ExtensionAPI);
  return { dir, registered, publish, handlers };
}

const row = (id: string, displayName = id, contextLength = 1000) => ({ id, displayName, contextLength, pricing: {} });

test("catalog rows become models, and bad rows are dropped", () => {
  assert.deepEqual(parseCatalog([row("kimi-k3", "Kimi K3", 256_000), { id: "bare" }, { displayName: "no id" }, null, "x"]), [
    { id: "kimi-k3", name: "Kimi K3", contextWindow: 256_000 },
    { id: "bare", name: "bare", contextWindow: 128_000 },
  ]);
  assert.deepEqual(parseCatalog("not rows"), []);
});

test("with no cache, models.json stays in charge until the catalog arrives", (t) => {
  const { registered } = load(t);
  assert.equal(registered.length, 0);
});

test("the cache is registered while loading, so a saved model resolves at startup", (t) => {
  const { registered } = load(t, { models: [row("kimi-k3", "Kimi K3")] });
  assert.deepEqual(registered[0].models.map((m) => m.id), ["kimi-k3"]);
  assert.equal(registered[0].baseUrl, "https://api.nusagate.com/v1");
});

test("a new catalog is registered and cached for the next startup", (t) => {
  const { dir, registered, publish } = load(t);
  publish([row("a", "Model A", 2000), row("b")]);
  assert.deepEqual(registered[0].models.map((m) => [m.id, m.name, m.contextWindow, m.maxTokens]), [
    // These windows are smaller than the default output limit, which is cut down to fit.
    ["a", "Model A", 2000, 2000],
    ["b", "b", 1000, 1000],
  ]);
  const cached = JSON.parse(readFileSync(join(dir, "nusagate-models.json"), "utf8"));
  assert.deepEqual(parseCatalog(cached.models).map((m) => m.id), ["a", "b"]);
});

test("an unchanged or empty catalog does not touch the session's models", (t) => {
  const { registered, publish } = load(t, { models: [row("a")] });
  assert.equal(registered.length, 1);
  publish([row("a")]);
  publish([]);
  assert.equal(registered.length, 1);
});

test("a corrupt cache falls back quietly", (t) => {
  const { registered } = load(t, { models: "nope" });
  assert.equal(registered.length, 0);
});

test("DeepSeek models get pi's thinking switch, never reasoning_effort, and the rest reason without one", (t) => {
  const { registered } = load(t, { models: [row("deepseek-v4.1-flash"), { ...row("deepseek-v9-chat"), reasoning: false }, { ...row("kimi-k3"), reasoning: true }] });
  const byId = Object.fromEntries(registered[0].models.map((model) => [model.id, model as Record<string, unknown>]));
  assert.equal(byId["deepseek-v4.1-flash"].reasoning, true);
  assert.deepEqual(byId["deepseek-v4.1-flash"].compat, { thinkingFormat: "deepseek", supportsReasoningEffort: false });
  assert.equal(byId["deepseek-v9-chat"].reasoning, false, "the catalog saying it doesn't reason wins");
  assert.equal(byId["kimi-k3"].reasoning, false, "reasons at the gateway by default; a thinking level would change nothing");
});

test("the catalog's reasoning flag is read and cached", (t) => {
  assert.deepEqual(parseCatalog([{ id: "a", reasoning: true }, { id: "b", reasoning: false }, { id: "c", reasoning: "yes" }]).map((m) => [m.id, m.reasoning]), [
    ["a", true],
    ["b", false],
    ["c", undefined],
  ]);
  const { dir, publish } = load(t);
  publish([{ ...row("a"), reasoning: true, input_modalities: ["text", "image"] }]);
  const cached = parseCatalog(JSON.parse(readFileSync(join(dir, "nusagate-models.json"), "utf8")).models);
  assert.deepEqual(cached, [{ id: "a", name: "a", contextWindow: 1000, vision: true, reasoning: true }]);
});

test("reasoning_effort is taken out of every NusaGate request, even when an old models.json asks for it", (t) => {
  const { handlers } = load(t);
  const send = (provider: string, payload: unknown) => handlers.before_provider_request({ type: "before_provider_request", payload }, { model: { provider } });
  assert.deepEqual(send("nusagate", { model: "deepseek-v4.1-flash", reasoning_effort: "high", thinking: { type: "enabled" } }), {
    model: "deepseek-v4.1-flash",
    thinking: { type: "enabled" },
  });
  assert.equal(send("nusagate", { model: "kimi-k3" }), undefined, "nothing to take out: the payload is left alone");
  assert.equal(send("openai", { model: "gpt", reasoning_effort: "high" }), undefined, "other providers are not NusaGate's rules");
  assert.equal(withoutReasoningEffort(null), null);
  assert.equal(withoutReasoningEffort("text"), null);
});

test("the shipped models.json doesn't ask for reasoning_effort either", () => {
  const shipped = readFileSync(join(import.meta.dirname, "..", "..", "config", "models.json"), "utf8");
  assert.ok(!shipped.includes('"supportsReasoningEffort": true'));
});

test("the user's capabilities file sets vision and output limits, and /model marks vision models", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-models-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "model-capabilities.json"),
    JSON.stringify({ "kimi-*": { vision: true, maxOutput: 8192 }, "kimi-k3.1-pro": { maxOutput: 32_768 } }),
  );
  writeFileSync(join(dir, "nusagate-models.json"), JSON.stringify({ models: [row("kimi-k3", "Kimi K3", 1_000_000), row("kimi-k3.1-pro", "Kimi K3.1 Pro", 1_000_000), row("glm-5.3", "GLM 5.3", 1_000_000)] }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const registered: { models: Record<string, unknown>[] }[] = [];
  models({
    registerProvider: (_name: string, config: { models: Record<string, unknown>[] }) => registered.push(config),
    on: () => {},
    events: { on: () => {} },
  } as unknown as ExtensionAPI);
  const byId = Object.fromEntries(registered[0].models.map((model) => [model.id, model]));
  assert.equal(byId["kimi-k3"].name, "Kimi K3 (vision)");
  assert.deepEqual(byId["kimi-k3"].input, ["text", "image"]);
  assert.equal(byId["kimi-k3"].maxTokens, 8192);
  assert.equal(byId["kimi-k3.1-pro"].maxTokens, 32_768);
  assert.equal(byId["glm-5.3"].name, "GLM 5.3");
  assert.deepEqual(byId["glm-5.3"].input, ["text"]);
  assert.equal(byId["glm-5.3"].maxTokens, 16_384);
});

test("a vision flag in the catalog is read, whatever shape it comes in", () => {
  const rows = [
    { id: "a", vision: true },
    { id: "b", input_modalities: ["text", "image"] },
    { id: "c", modalities: { input: ["text"] } },
    { id: "d", architecture: { input_modalities: ["image", "text"] } },
    { id: "e" },
  ];
  assert.deepEqual(parseCatalog(rows).map((m) => [m.id, m.vision]), [
    ["a", true],
    ["b", true],
    ["c", false],
    ["d", true],
    ["e", undefined],
  ]);
});
