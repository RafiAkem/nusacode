import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..", "..");
const script = join(root, "scripts", "check-pi-patches.cjs");
const { checkPatches, entryProblem } = require(script);
const { patches } = require(join(root, "scripts", "pi-build.cjs"));
const piDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");

/** Just the files the patches touch, copied from the installed pi, so a test can damage them. */
function patchedFilesCopy(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-pi-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const { file } of patches) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(piDir, file), join(dir, file));
  }
  cpSync(join(piDir, "package.json"), join(dir, "package.json"));
  return dir;
}

test("every patch applies to the pi that is installed", () => {
  assert.deepEqual(checkPatches(piDir), []);
});

test("a patch that stops matching is named, and the others are still checked", (t) => {
  const dir = patchedFilesCopy(t);
  const prompt = join(dir, "dist/core/system-prompt.js");
  writeFileSync(prompt, readFileSync(prompt, "utf8").replace("running inside pi", "running inside something else"));
  const slash = join(dir, "dist/core/slash-commands.js");
  writeFileSync(slash, readFileSync(slash, "utf8").replace("Report a bug to the Pi developers", "Tell us about a bug"));

  const failures = checkPatches(dir);
  assert.deepEqual(failures.map((failure: { file: string }) => failure.file), ["dist/core/slash-commands.js", "dist/core/system-prompt.js"]);
  assert.match(failures[0].error, /pi patch "\/bug description" did not match exactly once/);
  assert.match(failures[1].error, /pi patch "system prompt" did not match exactly once/);
});

test("a file that pi moved or removed is reported as such", (t) => {
  const dir = patchedFilesCopy(t);
  rmSync(join(dir, "dist/config.js"));
  assert.deepEqual(checkPatches(dir), [{ file: "dist/config.js", error: "the file no longer exists" }]);
});

/** Rewrites the copy's package.json so pi would start from `bin`. */
function startFrom(dir: string, bin: unknown) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  manifest.bin = bin;
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
}

test("patches that apply but would never be loaded are a failure too", (t) => {
  const dir = patchedFilesCopy(t);
  startFrom(dir, { pi: "dist/bundle/cli.js" });
  assert.match(entryProblem(dir), /pi starts from dist\/bundle\/cli\.js, a bundle .* never loaded/);
  startFrom(dir, { pi: "./dist/cli.js" });
  assert.equal(entryProblem(dir), null);
  startFrom(dir, "dist/cli.js");
  assert.equal(entryProblem(dir), null, "a plain string bin works too");
  startFrom(dir, undefined);
  assert.match(entryProblem(dir), /names no pi command/);
});

test("the pinned pi 1.5.0 is reported as patched but not running the patches (the known bundle defect)", () => {
  const result = spawnSync(process.execPath, [script, piDir], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^All \d+ patches apply to pi 1\.5\.0\.\nBut they would have no effect: pi starts from dist\/bundle\/cli\.js/);
});

test("the command line prints a verdict and exits 1 when something no longer applies", (t) => {
  const working = patchedFilesCopy(t);
  startFrom(working, { pi: "dist/cli.js" });
  const good = spawnSync(process.execPath, [script, working], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stdout);
  assert.match(good.stdout, /^All \d+ patches apply to pi \d+\.\d+\.\d+\.\n$/);

  const dir = patchedFilesCopy(t);
  startFrom(dir, { pi: "dist/cli.js" });
  rmSync(join(dir, "dist/config.js"));
  const bad = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^1 of \d+ patches no longer apply to pi \d+\.\d+\.\d+:\n {2}dist\/config\.js: the file no longer exists/);
});

test("the weekly upgrade check tries the newest pi, runs the patches check and the tests, and files one issue", () => {
  const workflow = parse(readFileSync(join(root, ".github", "workflows", "pi-upgrade.yml"), "utf8"));
  assert.ok(workflow.on.schedule[0].cron, "runs on a schedule");
  assert.ok("workflow_dispatch" in workflow.on, "and by hand");
  assert.equal(workflow.permissions.issues, "write");
  assert.equal(workflow.permissions.contents, "read");
  const steps: { name?: string; run?: string; if?: string; env?: Record<string, string> }[] = workflow.jobs.check.steps;
  const text = steps.map((step) => step.run ?? "").join("\n");
  assert.match(text, /npm view @earendil-works\/pi-coding-agent version/);
  assert.match(text, /npm install --no-save[^\n]*pi-coding-agent@/, "tries the new version without changing package.json");
  assert.match(text, /scripts\/check-pi-patches\.cjs/);
  const tests = steps.find((step) => (step.run ?? "").includes("npm test"));
  assert.equal(tests?.env?.NUSACODE_PI_UPGRADE_CHECK, "1", "tells the pin test that a different pi is expected");
  const issue = steps.find((step) => (step.run ?? "").includes("gh issue create"));
  assert.match(issue?.if ?? "", /failure\(\)/);
  assert.match(issue?.run ?? "", /gh issue list/, "looks for an open issue first, so a weekly failure doesn't pile up duplicates");
});
