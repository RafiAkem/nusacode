import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launcher = join(import.meta.dirname, "..", "..", "bin", "nusacode.js");

/** Runs the real launcher with no API key, so nothing it does can reach a model. */
function run(t: { after(fn: () => void): void }, ...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "nusacode-launcher-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { NUSAGATE_API_KEY: _key, ...env } = process.env;
  const result = spawnSync(process.execPath, [launcher, ...args], {
    env: { ...env, NUSACODE_HOME: home, PI_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { ...result, home };
}

test("update explains the real steps and never starts pi", (t) => {
  const { status, stdout, home } = run(t, "update");
  assert.equal(status, 0);
  assert.match(stdout, /git pull && npm install/);
  assert.equal(existsSync(join(home, "settings.json")), false, "exited before seeding the home");
});

test("pi's commands run as commands, not as a prompt", (t) => {
  const { status, stdout, stderr, home } = run(t, "list");
  assert.equal(status, 0, stderr);
  assert.match(stdout, /no packages installed/i);
  assert.equal(readFileSync(join(home, "models.json"), "utf8").includes("nusagate"), true);
});

test("a longer quoted prompt that starts with update is still a prompt", (t) => {
  const { stdout, stderr } = run(t, "-p", "update the readme");
  assert.doesNotMatch(stdout + stderr, /git pull/);
  const quoted = run(t, "update the readme", "-p");
  assert.doesNotMatch(quoted.stdout + quoted.stderr, /git pull/);
});
