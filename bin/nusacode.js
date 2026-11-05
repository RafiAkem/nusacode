#!/usr/bin/env node
// nusacode launcher: seeds default config into NUSACODE_HOME, then runs pi with
// that directory as its agent config dir and session store.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");

// pi updates a global pi, not the copy this package pins, so it can't update NusaCode.
if (process.argv[2] === "update") {
  if (fs.existsSync(path.join(root, ".git"))) {
    console.log("NusaCode is running from a checkout. To update it, run this in the repo:\n\n  git pull && npm install\n");
  } else {
    console.log("To update NusaCode, run:\n\n  npm install -g nusacode@latest\n");
  }
  console.log('To send "update" to the agent as a prompt, add more words in quotes: nusacode "update the readme"');
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
  },
});

child.on("error", (err) => {
  console.error(`nusacode: ${err.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code === null ? (signal ? 1 : 0) : code;
});
