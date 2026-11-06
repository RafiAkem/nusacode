import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITIES_FILE,
  DEFAULT_MAX_OUTPUT,
  parseCapabilities,
  readCapabilities,
  resolveCapabilities,
} from "../lib/model-capabilities.ts";

test("a model with no entry gets the defaults", () => {
  assert.deepEqual(resolveCapabilities("some-new-model", 1_000_000), {
    vision: false,
    maxOutput: DEFAULT_MAX_OUTPUT,
    contextWindow: 1_000_000,
  });
});

test("the verified built-in entry marks deepseek-v4.1-flash as a vision model", () => {
  assert.equal(resolveCapabilities("deepseek-v4.1-flash", 1_000_000).vision, true);
  assert.equal(resolveCapabilities("deepseek-v4-pro", 1_000_000).vision, false);
});

test("an exact id beats a prefix, and a longer prefix beats a shorter one", () => {
  const overrides = {
    "gpt-*": { maxOutput: 1000, vision: false },
    "gpt-6*": { maxOutput: 2000 },
    "gpt-6-sol": { maxOutput: 3000 },
  };
  assert.equal(resolveCapabilities("gpt-5.6-sol", 100_000, overrides).maxOutput, 1000);
  assert.equal(resolveCapabilities("gpt-6-luna", 100_000, overrides).maxOutput, 2000);
  assert.equal(resolveCapabilities("gpt-6-sol", 100_000, overrides).maxOutput, 3000);
  // Fields that the winner leaves out still come from the less specific entries.
  assert.equal(resolveCapabilities("gpt-6-sol", 100_000, { ...overrides, "gpt-6-sol": { vision: true } }).maxOutput, 2000);
});

test("the user's file beats the built-in table", () => {
  assert.equal(resolveCapabilities("deepseek-v4.1-flash", 1000, { "deepseek-v4.1-flash": { vision: false } }).vision, false);
});

test("no output limit is longer than the context window", () => {
  assert.equal(resolveCapabilities("tiny", 8000, { tiny: { maxOutput: 50_000 } }).maxOutput, 8000);
  assert.equal(resolveCapabilities("tiny", 8000).maxOutput, 8000, "the default too");
  assert.equal(resolveCapabilities("tiny", 100_000, { "tiny-*": { contextWindow: 8192 } }).maxOutput, DEFAULT_MAX_OUTPUT, "an override that doesn't match changes nothing");
  assert.equal(resolveCapabilities("tiny-1", 100_000, { "tiny-*": { contextWindow: 8192 } }).maxOutput, 8192, "a smaller window from an override caps the default");
});

test("a context window override replaces the catalog's figure", () => {
  assert.equal(resolveCapabilities("qwen3.8-27b", 131_072, { "qwen3.8-*": { contextWindow: 262_144 } }).contextWindow, 262_144);
});

test("bad values are ignored, not trusted", () => {
  assert.deepEqual(parseCapabilities({ vision: "yes", maxOutput: -5, contextWindow: 1.5, extra: 1 }), {});
  assert.deepEqual(parseCapabilities({ vision: true, maxOutput: 4096 }), { vision: true, maxOutput: 4096 });
  assert.deepEqual(parseCapabilities(null), {});
});

test("the file is read from the home, and a missing or broken one means no overrides", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-caps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readCapabilities(dir), {});
  writeFileSync(join(dir, CAPABILITIES_FILE), "{ not json");
  assert.deepEqual(readCapabilities(dir), {});
  writeFileSync(join(dir, CAPABILITIES_FILE), JSON.stringify([1, 2]));
  assert.deepEqual(readCapabilities(dir), {});
  writeFileSync(join(dir, CAPABILITIES_FILE), JSON.stringify({ "gpt-6-sol": { vision: true, maxOutput: 32768 }, bad: 7 }));
  assert.deepEqual(readCapabilities(dir), { "gpt-6-sol": { vision: true, maxOutput: 32768 }, bad: {} });
});

test("the models that passed the gateway image check are marked as vision models", () => {
  for (const id of ["deepseek-v4.1-flash", "gemini-3.8-flash", "gpt-5.6-luna", "gpt-6-sol", "grok-4.7", "kimi-k3", "minimax-m3", "qwen3.8-max-0902"]) {
    assert.equal(resolveCapabilities(id, 1_000_000).vision, true, id);
  }
  // The gateway answers these with a 400, "does not accept images".
  for (const id of ["deepseek-v4-pro", "glm-5.3", "qwen3.8-27b", "qwen3.8-max"]) {
    assert.equal(resolveCapabilities(id, 1_000_000).vision, false, id);
  }
});

test("a vision flag from the catalog beats the built-in table, and the user's file beats both", () => {
  assert.equal(resolveCapabilities("qwen3.8-max", 1000, {}, true).vision, true);
  assert.equal(resolveCapabilities("kimi-k3", 1000, {}, false).vision, false);
  assert.equal(resolveCapabilities("kimi-k3", 1000, { "kimi-k3": { vision: true } }, false).vision, true);
});
