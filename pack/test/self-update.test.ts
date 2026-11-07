import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..", "..");
const { failureHint, installMethod, isNewer, requestUpdate, selfUpdate, takeRequest, REQUEST_FILE } = require(join(root, "bin", "self-update.js"));

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake install at `dir`, at `version`. */
function install(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "nusacode", version }));
  return dir;
}

const npmSays = (version: string) => (async () => new Response(JSON.stringify({ version }))) as unknown as typeof fetch;

/** A spawn that "installs" `version` into `dir` and exits with `code`, printing `stderr`. */
function fakeSpawn(dir: string, version: string, code = 0, stderr = "") {
  const calls: { command: string; args: string[]; shell: boolean }[] = [];
  const impl = (command: string, args: string[], options: { shell: boolean }) => {
    calls.push({ command, args, shell: options.shell });
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    setImmediate(() => {
      if (stderr) child.stderr.emit("data", stderr);
      if (code === 0) install(dir, version);
      child.emit("exit", code);
    });
    return child;
  };
  return { impl, calls };
}

test("the update command matches how NusaCode was installed", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(installMethod(join(dir, "AppData/Roaming/npm/node_modules/nusacode"), "win32"), {
    kind: "global",
    command: "npm",
    args: ["install", "-g", "nusacode@latest"],
    display: "npm install -g nusacode@latest",
    shell: true,
  });
  assert.equal(installMethod("/usr/local/lib/node_modules/nusacode", "linux").shell, false, "no shell needed outside Windows");
  assert.equal(installMethod("/home/a/.local/share/pnpm/global/5/.pnpm/nusacode@0.1.3/node_modules/nusacode").command, "pnpm");
  assert.equal(installMethod("C:\\Users\\a\\AppData\\Local\\pnpm\\global\\5\\node_modules\\nusacode").command, "pnpm");
  assert.equal(installMethod("/home/a/.bun/install/global/node_modules/nusacode").command, "bun");
  assert.equal(installMethod("/home/a/.config/yarn/global/node_modules/nusacode").display, "yarn global add nusacode@latest");
  assert.deepEqual(installMethod("C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\nusacode"), { kind: "npx" });
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  assert.deepEqual(installMethod(join(dir, "repo")), { kind: "checkout" });
});

test("versions compare as numbers, and anything unusual is never newer", () => {
  assert.equal(isNewer("0.1.3", "0.1.4"), true);
  assert.equal(isNewer("0.1.9", "0.1.10"), true);
  assert.equal(isNewer("0.1.3", "0.1.3"), false);
  assert.equal(isNewer("0.2.0", "0.1.9"), false);
  assert.equal(isNewer("0.1.3", "0.2.0-beta.1"), false);
});

test("an update runs the package manager and reports the version it installed", async (t) => {
  const dir = install(join(tempDir(t), "npm", "node_modules", "nusacode"), "0.1.3");
  const spawn = fakeSpawn(dir, "0.1.4");
  const log: string[] = [];
  const result = await selfUpdate({ root: dir, log: (line: string) => log.push(line), spawnImpl: spawn.impl, fetchImpl: npmSays("0.1.4"), platform: "linux" });
  assert.equal(result, "updated");
  assert.deepEqual(spawn.calls, [{ command: "npm", args: ["install", "-g", "nusacode@latest"], shell: false }]);
  assert.match(log.join("\n"), /v0\.1\.3 → v0\.1\.4/);
  assert.match(log.join("\n"), /NusaCode is now v0\.1\.4\./);
});

test("nothing is installed when npm has nothing newer", async (t) => {
  const dir = install(join(tempDir(t), "nusacode"), "0.1.4");
  const spawn = fakeSpawn(dir, "0.1.4");
  const log: string[] = [];
  assert.equal(await selfUpdate({ root: dir, log: (l: string) => log.push(l), spawnImpl: spawn.impl, fetchImpl: npmSays("0.1.4") }), "current");
  assert.equal(spawn.calls.length, 0);
  assert.match(log[0]!, /up to date \(v0\.1\.4\)/);
});

test("when npm can't be asked first, the install still runs: it knows what latest is", async (t) => {
  const dir = install(join(tempDir(t), "nusacode"), "0.1.3");
  const spawn = fakeSpawn(dir, "0.1.4");
  const offline = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  assert.equal(await selfUpdate({ root: dir, log: () => {}, spawnImpl: spawn.impl, fetchImpl: offline }), "updated");
  assert.equal(spawn.calls.length, 1);
});

test("a checkout or npx is only told what to do", async (t) => {
  const dir = install(join(tempDir(t), "repo"), "0.1.0");
  mkdirSync(join(dir, ".git"));
  const spawn = fakeSpawn(dir, "9.9.9");
  const log: string[] = [];
  assert.equal(await selfUpdate({ root: dir, log: (l: string) => log.push(l), spawnImpl: spawn.impl, fetchImpl: npmSays("9.9.9") }), "manual");
  assert.equal(spawn.calls.length, 0);
  assert.match(log[0]!, /git pull && npm install/);
});

test("a failed install says why, in words someone can act on", async (t) => {
  const dir = install(join(tempDir(t), "nusacode"), "0.1.3");
  const spawn = fakeSpawn(dir, "0.1.4", 1, "npm error code EBUSY\nnpm error syscall rename");
  const log: string[] = [];
  assert.equal(await selfUpdate({ root: dir, log: (l: string) => log.push(l), spawnImpl: spawn.impl, fetchImpl: npmSays("0.1.4"), platform: "win32" }), "failed");
  assert.match(log.join("\n"), /Close every NusaCode window/);

  const npm = installMethod("/usr/lib/node_modules/nusacode", "linux");
  assert.match(failureHint("npm error code EACCES", npm, "linux"), /sudo npm install -g nusacode@latest/);
  assert.match(failureHint("npm error code ETARGET", npm), /still publishing/);
  assert.match(failureHint("npm error code ENOTFOUND", npm), /connection/);
  assert.match(failureHint("something else", npm), /npm install -g nusacode@latest/);
});

test("/update's request is taken once", (t) => {
  const home = tempDir(t);
  assert.equal(takeRequest(home), false);
  requestUpdate(join(home, "new"));
  assert.ok(existsSync(join(home, "new", REQUEST_FILE)));
  assert.equal(takeRequest(join(home, "new")), true);
  assert.equal(takeRequest(join(home, "new")), false);
});

test("the launcher clears stale requests before pi starts and updates after it exits", () => {
  const launcher = readFileSync(join(root, "bin", "nusacode.js"), "utf8");
  const spawnAt = launcher.indexOf("const child = spawn(");
  assert.ok(launcher.lastIndexOf("selfUpdate.takeRequest(home)", spawnAt) > 0, "a stale request is dropped first");
  assert.match(launcher.slice(spawnAt), /child\.on\("exit"[\s\S]*takeRequest\(home\)\) updateAndReopen\(\)/);
  assert.match(launcher, /NUSACODE_LAUNCHER: "1"/);
  assert.match(launcher, /\[launcher, "--continue"\]/);
});

test("nusacode update in a checkout explains instead of installing", () => {
  const run = spawnSync(process.execPath, [join(root, "bin", "nusacode.js"), "update"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /git checkout[\s\S]*git pull && npm install/);
});
