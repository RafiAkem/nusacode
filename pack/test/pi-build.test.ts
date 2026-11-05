import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..", "..");
const { buildPi, isCurrent, replaceOnce } = require(join(root, "scripts", "pi-build.cjs"));
const piDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");

/** One build shared by the tests that only read it. */
const target = mkdtempSync(join(tmpdir(), "nusacode-pi-"));
const options = { piDir, nusacodeDir: root, target };
buildPi(options);
test.after(() => rmSync(target, { recursive: true, force: true }));

const read = (file: string) => readFileSync(join(target, file), "utf8");

test("every patch still matches the pinned pi (a pi bump that breaks one fails here)", () => {
  // buildPi above would have thrown; this pins the version the patches were written for.
  assert.equal(JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).version, "1.5.0");
});

test("the copy is named NusaCode and carries NusaCode's version", () => {
  const manifest = JSON.parse(read("package.json"));
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "nusacode");
  assert.equal(manifest.version, own.version);
  assert.deepEqual(manifest.piConfig, { name: "nusacode", configDir: ".nusacode", title: "NSC" });
});

test("the window title is NSC and the session name, without the folder", () => {
  assert.match(read("dist/config.js"), /pkg\.piConfig\?\.title/);
  const mode = read("dist/modes/interactive/interactive-mode.js");
  assert.ok(mode.includes("`${APP_TITLE} - ${sessionName}`"));
  assert.ok(!mode.includes("${sessionName} - ${cwdBasename}"));
});

test("/bug opens a GitHub issue and uploads nothing", () => {
  const mode = read("dist/modes/interactive/interactive-mode.js");
  const start = mode.indexOf("async handleBugCommand(hint)");
  const body = mode.slice(start, mode.indexOf("async handleCopyCommand(", start));
  assert.ok(body.includes("github.com/RafiAkem/nusacode/issues/new"));
  assert.ok(body.includes("template: \"bug_report.yml\""));
  assert.ok(!body.includes("reportBug"), "no upload flow");
  assert.ok(!mode.includes("the crash details are attached automatically"));
  assert.match(read("dist/core/slash-commands.js"), /Report a bug to NusaCode on GitHub/);
});

test("/changelog shows NusaCode's changelog and the model is told it runs in NusaCode", () => {
  assert.equal(read("CHANGELOG.md"), readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  assert.match(read("dist/core/system-prompt.js"), /running inside NusaCode, a coding agent harness built on pi/);
});

test("the build is current until its inputs change", () => {
  assert.equal(isCurrent(options), true);
  const stale = mkdtempSync(join(tmpdir(), "nusacode-pi-stale-"));
  try {
    assert.equal(isCurrent({ ...options, target: stale }), false, "an empty folder is not a build");
    writeFileSync(join(target, ".nusacode-build"), "something else");
    assert.equal(isCurrent(options), false);
    writeFileSync(join(target, ".nusacode-build"), "x");
    buildPi(options);
    assert.equal(isCurrent(options), true);
  } finally {
    rmSync(stale, { recursive: true, force: true });
  }
});

test("replaceOnce refuses a missing or ambiguous match", () => {
  assert.equal(replaceOnce("a b c", "b", "X", "t"), "a X c");
  assert.throws(() => replaceOnce("a b c", "z", "X", "t"), /did not match exactly once/);
  assert.throws(() => replaceOnce("b b", "b", "X", "t"), /did not match exactly once/);
});
