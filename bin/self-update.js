"use strict";
/**
 * `nusacode update`, and `/update` inside NusaCode: installs the newest NusaCode with the
 * package manager it was installed with, so nobody has to remember the npm command.
 *
 * `/update` can't install while NusaCode is running: on Windows, pi's native terminal module is
 * locked while loaded, so npm can't replace it. Instead it leaves a request file in the NusaCode
 * home and quits; the launcher, which outlives pi, sees the file once pi has exited, updates, and
 * reopens the same session.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REQUEST_FILE = "update-requested";
const LATEST_URL = "https://registry.npmjs.org/nusacode/latest";

/**
 * How this copy of NusaCode was installed, judged from where it lives:
 *   checkout: a git clone, updated with git
 *   npx:      npx's cache, which runs whatever npx fetched; `npx nusacode@latest` gets the newest
 *   global:   a global install, with the command that updates it
 */
function installMethod(root, platform = process.platform) {
  if (fs.existsSync(path.join(root, ".git"))) return { kind: "checkout" };
  const where = root.replace(/\\/g, "/").toLowerCase();
  if (where.includes("/_npx/")) return { kind: "npx" };
  const [command, args] = where.includes("/pnpm/") || where.includes("/.pnpm/")
    ? ["pnpm", ["add", "-g", "nusacode@latest"]]
    : where.includes("/.bun/")
      ? ["bun", ["add", "-g", "nusacode@latest"]]
      : where.includes("/.yarn/") || where.includes("/yarn/global/")
        ? ["yarn", ["global", "add", "nusacode@latest"]]
        : ["npm", ["install", "-g", "nusacode@latest"]];
  // npm, pnpm and yarn are .cmd files on Windows, which only a shell can start.
  return { kind: "global", command, args, display: [command, ...args].join(" "), shell: platform === "win32" };
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  return match ? match.slice(1).map(Number) : null;
}

/** True when `latest` is a higher plain x.y.z release than `current`. */
function isNewer(current, latest) {
  const a = parse(current);
  const b = parse(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}

/** The newest version on npm, or null when npm can't be reached in time. */
async function latestVersion(fetchImpl = fetch, url = LATEST_URL) {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const { version } = await res.json();
    return typeof version === "string" && parse(version) ? version : null;
  } catch {
    return null;
  }
}

/** The version now installed at `root`, read fresh from disk (not require's cache). */
function installedVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function runCommand(method, spawnImpl) {
  return new Promise((resolve) => {
    let output = "";
    const child = spawnImpl(method.command, method.args, { stdio: ["inherit", "inherit", "pipe"], shell: method.shell });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (err) => resolve({ code: 1, output: `${output}${err.message}` }));
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

/** What to tell someone whose install failed, from what the package manager printed. */
function failureHint(output, method, platform = process.platform) {
  if (/EBUSY|EPERM|resource busy|operation not permitted/i.test(output) && platform === "win32") {
    return "Another NusaCode window is still open, so Windows won't let its files be replaced. Close every NusaCode window, then run: nusacode update";
  }
  if (/EACCES|permission denied/i.test(output)) {
    return `Your global packages folder needs admin rights. Run: sudo ${method.display}`;
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/i.test(output)) {
    return "npm couldn't be reached. Check your connection and run: nusacode update";
  }
  if (/ETARGET|notarget/i.test(output)) {
    return "npm is still publishing the new version. Wait a minute and run: nusacode update";
  }
  return `The update didn't finish. To update by hand, run: ${method.display}`;
}

/**
 * Updates NusaCode. Returns "updated", "current" (nothing newer), "manual" (a checkout or npx,
 * where it only explains) or "failed".
 */
async function selfUpdate({ root, log = console.log, spawnImpl = spawn, fetchImpl, platform = process.platform } = {}) {
  const current = installedVersion(root);
  const method = installMethod(root, platform);
  if (method.kind === "checkout") {
    log("NusaCode is running from a git checkout. To update it, run this in the repo:\n\n  git pull && npm install\n");
    return "manual";
  }
  if (method.kind === "npx") {
    log("NusaCode is running through npx. To run the newest version, use:\n\n  npx nusacode@latest\n");
    return "manual";
  }
  const latest = await latestVersion(fetchImpl);
  if (latest && current && !isNewer(current, latest)) {
    log(`NusaCode is up to date (v${current}).`);
    return "current";
  }
  log(latest ? `Updating NusaCode v${current} → v${latest} …\n> ${method.display}\n` : `Updating NusaCode …\n> ${method.display}\n`);
  const { code, output } = await runCommand(method, spawnImpl);
  if (code !== 0) {
    log(`\n${failureHint(output, method, platform)}`);
    return "failed";
  }
  const now = installedVersion(root);
  log(now && now !== current ? `\nNusaCode is now v${now}.` : "\nNusaCode is updated.");
  return "updated";
}

/** Called by `/update`: leaves the request the launcher acts on once pi has exited. */
function requestUpdate(home) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, REQUEST_FILE), `${new Date().toISOString()}\n`);
}

/** True, and the request removed, when `/update` asked for an update. */
function takeRequest(home) {
  try {
    fs.unlinkSync(path.join(home, REQUEST_FILE));
    return true;
  } catch {
    return false;
  }
}

module.exports = { REQUEST_FILE, failureHint, installMethod, isNewer, latestVersion, requestUpdate, selfUpdate, takeRequest };
