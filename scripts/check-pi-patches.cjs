"use strict";
/**
 * Does NusaCode's list of source patches (scripts/pi-build.cjs) still match a pi release?
 *
 *   node scripts/check-pi-patches.cjs [path to a pi-coding-agent package]
 *
 * Building the patched copy stops at the first patch that no longer matches. This tries each patch
 * on its own and reports all of them, so one run says everything an upgrade has to fix. Exits 1
 * when any patch fails. Used by .github/workflows/pi-upgrade.yml.
 */
const fs = require("node:fs");
const path = require("node:path");
const { patches } = require("./pi-build.cjs");

/** One entry per patch that fails on the pi package in `piDir`; empty when all of them apply. */
function checkPatches(piDir) {
  const failures = [];
  for (const { file, apply } of patches) {
    try {
      apply(fs.readFileSync(path.join(piDir, file), "utf8"));
    } catch (err) {
      failures.push({ file, error: err.code === "ENOENT" ? "the file no longer exists" : err.message });
    }
  }
  return failures;
}

function main() {
  const piDir = process.argv[2] ?? path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent");
  const version = JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8")).version;
  const failures = checkPatches(piDir);
  if (failures.length === 0) {
    console.log(`All ${patches.length} patches apply to pi ${version}.`);
    return 0;
  }
  console.log(`${failures.length} of ${patches.length} patches no longer apply to pi ${version}:`);
  for (const { file, error } of failures) console.log(`  ${file}: ${error}`);
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkPatches };
