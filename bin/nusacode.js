#!/usr/bin/env node
// nusacode launcher: seeds default config into NUSACODE_HOME, then runs pi with
// that directory as its agent config dir and session store.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");

const selfUpdate = require("./self-update.js");

// pi's own updater installs a global pi, not the copy this package pins, so NusaCode has its own.
if (process.argv.length === 3 && process.argv[2] === "update") {
  selfUpdate.selfUpdate({ root }).then(
    (result) => {
      if (result === "updated") console.log("Run nusacode to start it.");
      process.exitCode = result === "failed" ? 1 : 0;
    },
    (err) => {
      console.error(`nusacode: ${err.message}`);
      process.exitCode = 1;
    },
  );
  return;
}

// --version names both halves: this package and the pi it runs on, which matters when
// a report comes in and someone has to tell which one a bug belongs to.
if (process.argv.length === 3 && (process.argv[2] === "--version" || process.argv[2] === "-v")) {
  const own = require(path.join(root, "package.json")).version;
  let pi = "unknown";
  try {
    pi = require(path.join(piPackageDir(), "package.json")).version;
  } catch {
    // Not installed yet: still say what NusaCode is.
  }
  console.log(`nusacode ${own} (pi ${pi})`);
  process.exit(0);
}

const home =path.resolve(process.env.NUSACODE_HOME || path.join(os.homedir(), ".nusacode"));
const sessionDir = path.join(home, "sessions");

// Seed defaults once; never overwrite a file the user already has.
fs.mkdirSync(sessionDir, { recursive: true });
function seed(source, target) {
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}
seed(path.join(root, "config", "settings.default.json"), path.join(home, "settings.json"));
seed(path.join(root, "config", "models.json"), path.join(home, "models.json"));

// Existing homes gain defaults added since they were seeded. A key the user
// already has keeps its value, so /settings choices survive. The changelog
// version always tracks pi: its changelog describes pi, not NusaCode, and pi
// has no setting to hide it.
function updateSettings(source, target) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return; // A file we can't parse is the user's to fix; pi reports it.
  }
  const merged = {
    ...JSON.parse(fs.readFileSync(source, "utf8")),
    ...settings,
    lastChangelogVersion: require(path.join(root, "package.json")).version,
  };
  if (JSON.stringify(merged) === JSON.stringify(settings)) return;
  fs.writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`);
}
updateSettings(path.join(root, "config", "settings.default.json"), path.join(home, "settings.json"));

// Agent definitions for the `task` tool, seeded the same way.
const agentsDir = path.join(home, "agents");
fs.mkdirSync(agentsDir, { recursive: true });
const agentsSrc = path.join(root, "config", "agents");
if (fs.existsSync(agentsSrc)) {
  for (const name of fs.readdirSync(agentsSrc)) {
    seed(path.join(agentsSrc, name), path.join(agentsDir, name));
  }
}

// Locate a package directory by walking up from this package (handles nested and hoisted installs).
function findPackage(...segments) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, "node_modules", ...segments, "package.json");
    if (fs.existsSync(pkg)) return path.dirname(pkg);
    if (path.dirname(dir) === dir) return null;
  }
}

function piPackageDir() {
  const dir = findPackage("@earendil-works", "pi-coding-agent");
  if (!dir) throw new Error("@earendil-works/pi-coding-agent is not installed; run npm install");
  return dir;
}

// NusaCode runs its own patched copy of pi (see scripts/pi-build.cjs), built once and kept
// in vendor/pi. If it can't be built, say a read-only install, run the stock pi instead
// of not starting at all.
let patchedPi;
function piDirectory() {
  if (patchedPi) return patchedPi;
  const stock = piPackageDir();
  const build = require("../scripts/pi-build.cjs");
  const options = { piDir: stock, nusacodeDir: root, target: path.join(root, "vendor", "pi") };
  try {
    if (!build.isCurrent(options)) build.buildPi(options);
    patchedPi = options.target;
  } catch (err) {
    console.error(`nusacode: could not prepare its patched pi (${err.message}); running stock pi.`);
    patchedPi = stock;
  }
  return patchedPi;
}

function piCli() {
  const dir = piDirectory();
  return path.join(dir, require(path.join(dir, "package.json")).bin.pi);
}

// Load the NusaCode pi-package. Falls back to the repo checkout before `npm install`.
function packDir() {
  const installed = findPackage("@nusacode", "pack");
  if (installed) return installed;
  const local = path.join(root, "pack");
  return fs.existsSync(path.join(local, "package.json")) ? local : null;
}

// Spawn node directly (no shell): bash.exe on Windows is an unusable WSL relay.
const pack = packDir();
const args = process.argv.slice(2);
// pi only recognizes these as commands in first position; after our flags they
// would reach the model as a prompt, and the agent would act on them.
const PI_COMMANDS = new Set(["install", "remove", "uninstall", "list", "config", "auth", "mcp"]);
const flags = PI_COMMANDS.has(args[0]) ? [] : ["--session-dir", sessionDir, ...(pack ? ["-e", pack] : [])];
// A request left over from a session that crashed before it could be acted on is stale.
selfUpdate.takeRequest(home);

const child = spawn(process.execPath, [piCli(), ...flags, ...args], {
  stdio: "inherit",
  // The notice says "pi update", which doesn't apply: this package pins its pi version.
  env: {
    ...process.env,
    // The patched pi reads the first name; the stock pi the second.
    NUSACODE_CODING_AGENT_DIR: home,
    PI_CODING_AGENT_DIR: home,
    PI_SKIP_VERSION_CHECK: "1",
    // pi pings its own servers about installs and tags requests as coming from pi.
    PI_TELEMETRY: "0",
    // Tells /update that this launcher will act on its request.
    NUSACODE_LAUNCHER: "1",
  },
});

child.on("error", (err) => {
  console.error(`nusacode: ${err.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code === null ? (signal ? 1 : 0) : code;
  // /update quit pi so its files can be replaced: update now, then reopen the same session.
  if (selfUpdate.takeRequest(home)) updateAndReopen();
});

async function updateAndReopen() {
  const result = await selfUpdate.selfUpdate({ root }).catch((err) => {
    console.error(`nusacode: ${err.message}`);
    return "failed";
  });
  const launcher = path.join(root, "bin", "nusacode.js");
  // pnpm and bun install each version in its own folder, so the old path may be gone.
  if (result === "failed" || !fs.existsSync(launcher)) {
    if (result !== "failed") console.log("Run nusacode --continue to pick up where you left off.");
    process.exitCode = result === "failed" ? 1 : 0;
    return;
  }
  console.log("");
  // A fresh process, so the new version's code is what runs.
  const next = spawn(process.execPath, [launcher, "--continue"], { stdio: "inherit" });
  next.on("error", () => console.log("Run nusacode --continue to pick up where you left off."));
  next.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}
