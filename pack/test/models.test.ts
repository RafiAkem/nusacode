import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CATALOG_CHANNEL } from "../extensions/meter.ts";
import models, { parseCatalog } from "../extensions/models.ts";

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
  models({
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
  return { dir, registered, publish };
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
    ["a", "Model A", 2000, 16_384],
    ["b", "b", 1000, 16_384],
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

test("DeepSeek models are registered as reasoning models and the rest are not", (t) => {
  const { registered } = load(t, { models: [row("deepseek-v4.1-flash"), row("kimi-k3")] });
  const byId = Object.fromEntries(registered[0].models.map((model) => [model.id, model as Record<string, unknown>]));
  assert.equal(byId["deepseek-v4.1-flash"].reasoning, true);
  assert.deepEqual(byId["deepseek-v4.1-flash"].compat, { thinkingFormat: "deepseek", supportsReasoningEffort: true });
  assert.equal(byId["kimi-k3"].reasoning, false);
});
