import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLanguage, readLanguage, withLanguage, writeLanguage } from "../lib/language.ts";

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

test("a chosen language adds one instruction to the system prompt; none or auto adds nothing", () => {
  assert.equal(withLanguage("base", null), "base");
  assert.equal(withLanguage("base", "auto"), "base");
  const indonesian = withLanguage("base", "id");
  assert.match(indonesian, /^base\n\n<reply_language>\nAlways reply in Bahasa Indonesia/);
  assert.match(indonesian, /Keep code, identifiers, commands/);
  assert.equal(withLanguage("base", "id"), indonesian, "the same choice gives the same prompt, so the cache holds");
  assert.match(withLanguage("base", "en"), /Always reply in English/);
});

test("findLanguage takes an id or a name", () => {
  assert.equal(findLanguage("id")?.label, "Bahasa Indonesia");
  assert.equal(findLanguage("English")?.id, "en");
  assert.equal(findLanguage("AUTO")?.id, "auto");
  assert.equal(findLanguage("fr"), undefined);
});
