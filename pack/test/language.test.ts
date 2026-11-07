import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLanguage, readLanguage, writeLanguage } from "../lib/language.ts";
import { format, locale, messages, REGISTRY, setLocale } from "../lib/i18n.ts";
// Every module with UI text, so their tables are in the registry for the checks below.
import "../lib/setup-steps.ts";
import "../lib/setup-wizard.ts";
import "../lib/splash.ts";
import "../extensions/setup.ts";
import "../extensions/language.ts";
import "../extensions/update.ts";
import "../extensions/meter.ts";
import "../lib/usage-log.ts";
import "../lib/budget.ts";
import "../extensions/budget.ts";
import "../lib/estimate.ts";
import "../extensions/estimate.ts";
import "../extensions/brand.ts";
import "../extensions/sessions.ts";
import "../extensions/images.ts";
import "../extensions/tools-view.ts";
import "../extensions/token-saver.ts";
import "../extensions/subagents.ts";
import "../extensions/learn.ts";
import "../lib/skill-review.ts";
import "../extensions/plan.ts";
import "../lib/plan-mode.ts";
import "../extensions/undo.ts";
import "../lib/checkpoints.ts";
import "../extensions/ask.ts";
import "../lib/ask-panel.ts";

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-language-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the language is saved and read back, and anything unknown reads as unset", (t) => {
  const dir = tempDir(t);
  assert.equal(readLanguage(dir), null);
  writeLanguage(dir, "id");
  assert.equal(readLanguage(dir), "id");
  writeFileSync(join(dir, "language.json"), JSON.stringify({ language: "klingon" }));
  assert.equal(readLanguage(dir), null);
  writeFileSync(join(dir, "language.json"), "{ broken");
  assert.equal(readLanguage(dir), null);
});

test("findLanguage takes an id or a name", () => {
  assert.equal(findLanguage("id")?.label, "Bahasa Indonesia");
  assert.equal(findLanguage("English")?.id, "en");
  assert.equal(findLanguage("indonesian")?.id, "id");
  assert.equal(findLanguage("fr"), undefined);
});

test("outside the launcher the UI is English, whatever the developer picked", () => {
  assert.equal(locale(), "en");
});

test("messages pick the language in use and fill placeholders", (t) => {
  t.after(() => setLocale("en"));
  const m = messages({ hi: "Hi {name}" }, { hi: "Halo {name}" });
  assert.equal(m("hi", { name: "Rafi" }), "Hi Rafi");
  setLocale("id");
  assert.equal(m("hi", { name: "Rafi" }), "Halo Rafi");
  assert.equal(format("{a} and {b}", { a: 1 }), "1 and {b}", "a missing value leaves the placeholder");
});

test("every Indonesian message has the same keys and placeholders as its English one", () => {
  assert.ok(REGISTRY.length >= 20, `the UI modules registered their tables (${REGISTRY.length})`);
  const placeholders = (text: string): string => [...text.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",");
  for (const { en, id } of REGISTRY) {
    assert.deepEqual(Object.keys(id).sort(), Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      assert.equal(placeholders(id[key]!), placeholders(en[key]!), `placeholders of "${key}"`);
      assert.ok(id[key]!.trim() !== "", `"${key}" is translated`);
    }
  }
});
