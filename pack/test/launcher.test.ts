import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launcher = join(import.meta.dirname, "..", "..", "bin", "nusacode.js");

/** Runs the real launcher with no API key, so nothing it does can reach a model. */
function run(t: { after(fn: () => void): void }, ...input: (string | { home: string })[]) {
  const last = input.at(-1);
  const given = typeof last === "object" ? last.home : null;
  const args = input.filter((value): value is string => typeof value === "string");
  const home = given ?? mkdtempSync(join(tmpdir(), "nusacode-launcher-"));
  if (!given) t.after(() => rmSync(home, { recursive: true, force: true }));
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

test("settings keep the user's values and track NusaCode's version so the changelog stays hidden", (t) => {
  const home = mkdtempSync(join(tmpdir(), "nusacode-launcher-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const settingsPath = join(home, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultModel: "my-pick", lastChangelogVersion: "0.0.1" }));

  const { status, stderr } = run(t, "list", { home });
  assert.equal(status, 0, stderr);

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const own = join(import.meta.dirname, "..", "..", "package.json");
  assert.equal(settings.lastChangelogVersion, JSON.parse(readFileSync(own, "utf8")).version);
  assert.equal(settings.defaultModel, "my-pick");
  assert.equal(settings.tuiMode, "regular");
});

test("a longer quoted prompt that starts with update is still a prompt", (t) => {
  const { stdout, stderr } = run(t, "-p", "update the readme");
  assert.doesNotMatch(stdout + stderr, /git pull/);
  const quoted = run(t, "update the readme", "-p");
  assert.doesNotMatch(quoted.stdout + quoted.stderr, /git pull/);
});

test("--version names NusaCode and the pi it runs on, and starts nothing", (t) => {
  const root = join(import.meta.dirname, "..", "..");
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const pi = JSON.parse(readFileSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
  for (const flag of ["--version", "-v"]) {
    const { status, stdout, home } = run(t, flag);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), `nusacode ${own} (pi ${pi})`);
    assert.equal(existsSync(join(home, "settings.json")), false, "exited before seeding the home");
  }
});
