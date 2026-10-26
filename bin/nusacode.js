#!/usr/bin/env node
// nusacode launcher: seeds default config into NUSACODE_HOME, then runs pi with
// that directory as its agent config dir and session store.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const home = path.resolve(process.env.NUSACODE_HOME || path.join(os.homedir(), ".nusacode"));
const sessionDir = path.join(home, "sessions");

// Seed defaults once; never overwrite a file the user already has.
fs.mkdirSync(sessionDir, { recursive: true });
for (const name of ["settings.json", "models.json"]) {
  const src = path.join(root, "config", name === "settings.json" ? "settings.default.json" : name);
  try {
    fs.copyFileSync(src, path.join(home, name), fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
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

function piCli() {
  const dir = findPackage("@earendil-works", "pi-coding-agent");
  if (!dir) throw new Error("@earendil-works/pi-coding-agent is not installed; run npm install");
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
const child = spawn(
  process.execPath,
  [piCli(), "--session-dir", sessionDir, ...(pack ? ["-e", pack] : []), ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: home } },
);

child.on("error", (err) => {
  console.error(`nusacode: ${err.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code === null ? (signal ? 1 : 0) : code;
});
