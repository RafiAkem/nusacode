import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableUpdate, CHECK_EVERY_MS, isNewer, readCache, UPDATE_FILE } from "../lib/update-check.ts";

function dirs(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "nusacode-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const install = join(root, "install");
  mkdirSync(install, { recursive: true });
  return { root, home, install };
}

/** A fetch that answers with `version` and counts calls. */
function registry(version: string | Error, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (version instanceof Error) throw version;
    return new Response(JSON.stringify({ name: "nusacode", version }), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const env = {} as NodeJS.ProcessEnv;

test("isNewer compares plain releases and ignores anything else", () => {
  assert.equal(isNewer("0.1.1", "0.1.2"), true);
  assert.equal(isNewer("0.1.9", "0.2.0"), true);
  assert.equal(isNewer("0.9.0", "1.0.0"), true);
  assert.equal(isNewer("0.1.10", "0.1.9"), false, "numbers, not strings");
  assert.equal(isNewer("0.1.2", "0.1.2"), false);
  assert.equal(isNewer("0.1.2", "0.1.1"), false);
  assert.equal(isNewer("0.1.0", "0.0.0-stage"), false);
  assert.equal(isNewer("0.1.0", "garbage"), false);
});

test("a newer version on npm is reported and remembered", async (t) => {
  const { home, install } = dirs(t);
  const r = registry("0.1.2");
  assert.equal(await availableUpdate({ current: "0.1.1", dir: home, installDir: install, now: 1_000, fetchImpl: r.fetchImpl, env }), "0.1.2");
  assert.deepEqual(readCache(home), { checkedAt: 1_000, latest: "0.1.2" });
  assert.match(r.calls[0]!, /registry\.npmjs\.org\/nusacode\/latest/);
});

test("npm is asked at most once a day", async (t) => {
  const { home, install } = dirs(t);
  const r = registry("0.1.2");
  const ask = (now: number) => availableUpdate({ current: "0.1.1", dir: home, installDir: install, now, fetchImpl: r.fetchImpl, env });
  await ask(1_000);
  assert.equal(await ask(1_000 + CHECK_EVERY_MS - 1), "0.1.2", "answered from the cache");
  assert.equal(r.calls.length, 1);
  await ask(1_000 + CHECK_EVERY_MS);
  assert.equal(r.calls.length, 2, "asked again after a day");
});

test("being up to date, offline, or getting junk reports nothing, and offline waits a day too", async (t) => {
  const { home, install } = dirs(t);
  assert.equal(await availableUpdate({ current: "0.1.2", dir: home, installDir: install, now: 1, fetchImpl: registry("0.1.2").fetchImpl, env }), null);

  const offline = registry(new Error("ENOTFOUND"));
  rmSync(join(home, UPDATE_FILE));
  assert.equal(await availableUpdate({ current: "0.1.1", dir: home, installDir: install, now: 1, fetchImpl: offline.fetchImpl, env }), null);
  await availableUpdate({ current: "0.1.1", dir: home, installDir: install, now: 2, fetchImpl: offline.fetchImpl, env });
  assert.equal(offline.calls.length, 1, "a failed check is not retried until tomorrow");

  rmSync(join(home, UPDATE_FILE));
  assert.equal(await availableUpdate({ current: "0.1.1", dir: home, installDir: install, now: 1, fetchImpl: registry("not-a-version").fetchImpl, env }), null);
  rmSync(join(home, UPDATE_FILE));
  assert.equal(await availableUpdate({ current: "0.1.1", dir: home, installDir: install, now: 1, fetchImpl: registry("0.1.2", 503).fetchImpl, env }), null);
});

test("a failed check keeps the last known answer", async (t) => {
  const { home, install } = dirs(t);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, UPDATE_FILE), JSON.stringify({ checkedAt: 0, latest: "0.1.5" }));
  const offline = registry(new Error("timeout"));
  const result = await availableUpdate({ current: "0.1.1", dir: home, installDir: install, now: CHECK_EVERY_MS * 2, fetchImpl: offline.fetchImpl, env });
  assert.equal(result, "0.1.5");
  assert.equal(JSON.parse(readFileSync(join(home, UPDATE_FILE), "utf8")).checkedAt, CHECK_EVERY_MS * 2);
});

test("no check from a git checkout, or when turned off", async (t) => {
  const { home, install } = dirs(t);
  const r = registry("9.9.9");
  assert.equal(await availableUpdate({ current: "0.1.0", dir: home, installDir: install, fetchImpl: r.fetchImpl, env: { NUSACODE_NO_UPDATE_CHECK: "1" } }), null);
  assert.equal(await availableUpdate({ current: "0.1.0", dir: home, installDir: install, fetchImpl: r.fetchImpl, env: { PI_OFFLINE: "1" } }), null);
  mkdirSync(join(install, ".git"));
  assert.equal(await availableUpdate({ current: "0.1.0", dir: home, installDir: install, fetchImpl: r.fetchImpl, env }), null);
  assert.equal(r.calls.length, 0, "npm was never asked");
});
