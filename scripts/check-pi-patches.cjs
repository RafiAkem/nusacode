"use strict";
/**
 * Do NusaCode's pi patches (scripts/pi-build.cjs) still match a pi release?
 *
 *   node scripts/check-pi-patches.cjs [path to a pi-coding-agent package]
 *
 * Building the patched copy stops at the first patch that no longer matches. This tries each patch
 * on its own and reports all of them, so one run says everything an upgrade has to fix.
 *
 * There are two lists: the source patches, for pi's separate files under dist/, and the bundle
 * patches, for dist/bundle, which pi 1.5.0 starts from and which holds its own copy of the code.
 * A patch that applies is still no use if pi never loads that code, so this also checks that pi
 * starts from somewhere the patches cover.
 *
 * Exits 1 when any patch fails or the patches wouldn't reach the running app. Used by
 * .github/workflows/pi-upgrade.yml.
 */
const fs = require("node:fs");
const path = require("node:path");
const { bundlePatches, patchBundle, patches } = require("./pi-build.cjs");

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
  for (const { error } of patchBundle(piDir).failures) failures.push({ file: "dist/bundle", error });
  return failures;
}

/** Why the patched code wouldn't be what runs, or null when it would be. */
function entryProblem(piDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  if (typeof bin !== "string") return "pi's package.json names no pi command";
  const entry = bin.replace(/\\/g, "/").replace(/^\.\//, "");
  // dist/bundle/... is covered by the bundle patches, anything else under dist/ by the source patches.
  if (!entry.startsWith("dist/")) return `pi starts from ${entry}, which neither the source nor the bundle patches cover`;
  return null;
}

function main() {
  const piDir = process.argv[2] ?? path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent");
  const version = JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8")).version;
  const total = patches.length + bundlePatches.length;
  const failures = checkPatches(piDir);
  if (failures.length === 0) {
    console.log(`All ${total} patches apply to pi ${version}.`);
  } else {
    console.log(`${failures.length} of ${total} patches no longer apply to pi ${version}:`);
    for (const { file, error } of failures) console.log(`  ${file}: ${error}`);
  }
  const problem = entryProblem(piDir);
  if (problem) console.log(`But they would have no effect: ${problem}.`);
  return failures.length === 0 && !problem ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkPatches, entryProblem };
