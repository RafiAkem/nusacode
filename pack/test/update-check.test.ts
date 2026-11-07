import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableUpdate, isNewer, readCache, UPDATE_FILE } from "../lib/update-check.ts";

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

test("npm is asked on every start, so a release shows the next time NusaCode opens", async (t) => {
  const { home, install } = dirs(t);
  const ask = (version: string) => availableUpdate({ current: "0.1.4", dir: home, installDir: install, now: 1_000, fetchImpl: registry(version).fetchImpl, env });
  assert.equal(await ask("0.1.4"), null);
  assert.equal(await ask("0.1.5"), "0.1.5", "a minute later, a new release: no waiting for tomorrow");
  assert.deepEqual(readCache(home), { checkedAt: 1_000, latest: "0.1.5" });
});

test("being up to date, offline, or getting junk reports nothing", async (t) => {
  const { home, install } = dirs(t);
  assert.equal(await availableUpdate({ current: "0.1.2", dir: home, installDir: install, now: 1, fetchImpl: registry("0.1.2").fetchImpl, env }), null);

  const offline = registry(new Error("ENOTFOUND"));
  rmSync(join(home, UPDATE_FILE));
  assert.equal(await availableUpdate({ current: "0.1.1", dir: home, installDir: install, now: 1, fetchImpl: offline.fetchImpl, env }), null);
  assert.equal(readCache(home), null, "a failed check saves nothing");
  assert.equal(await availableUpdate({ current: "0.1.1", dir: home, installDir: install, now: 1, fetchImpl: registry("not-a-version").fetchImpl, env }), null);
  assert.equal(await availableUpdate({ current: "0.1.1", dir: home, installDir: install, now: 1, fetchImpl: registry("0.1.2", 503).fetchImpl, env }), null);
});

test("a failed check keeps the last known answer", async (t) => {
  const { home, install } = dirs(t);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, UPDATE_FILE), JSON.stringify({ checkedAt: 0, latest: "0.1.5" }));
  const offline = registry(new Error("timeout"));
  const result = await availableUpdate({ current: "0.1.1", dir: home, installDir: install, now: 5_000, fetchImpl: offline.fetchImpl, env });
  assert.equal(result, "0.1.5");
  assert.equal(JSON.parse(readFileSync(join(home, UPDATE_FILE), "utf8")).checkedAt, 0, "the last real answer is kept as it was");
  assert.equal(await availableUpdate({ current: "0.1.5", dir: home, installDir: install, fetchImpl: offline.fetchImpl, env }), null, "once updated, the old answer is no longer news");
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
