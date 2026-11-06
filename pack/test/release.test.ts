import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..", "..");
const script = join(root, "scripts", "release.cjs");
const { nextVersion, shippedPaths, shippedChanges, changelogSection } = require(script);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the next version is npm's next patch, unless package.json asks for more", () => {
  assert.equal(nextVersion("0.1.0", "0.1.0"), "0.1.1");
  assert.equal(nextVersion("0.1.0", "0.1.7"), "0.1.8", "package.json behind npm: npm wins");
  assert.equal(nextVersion("0.2.0", "0.1.7"), "0.2.0", "a minor bump in package.json is published as written");
  assert.equal(nextVersion("1.0.0", "0.9.9"), "1.0.0");
  assert.equal(nextVersion("0.1.9", "0.1.7"), "0.1.9", "a higher patch in package.json is kept too");
  assert.equal(nextVersion("0.1.0", "0.0.0"), "0.1.0", "nothing on npm yet");
  assert.equal(nextVersion("0.0.0", "0.0.0"), "0.0.1");
  assert.equal(nextVersion("0.1.0", "0.10.2"), "0.10.3", "compares numbers, not text");
  assert.throws(() => nextVersion("0.1.0", "1.0.0-beta.1"), /not a plain x\.y\.z version/);
});

test("only changes to what ships are a reason to release", () => {
  const shipped = (...files: string[]) => shippedChanges(files, manifest);
  assert.deepEqual(shipped("bin/nusacode.js"), ["bin/nusacode.js"]);
  assert.deepEqual(shipped("pack/extensions/meter.ts", "pack/lib/money.ts", "pack/themes/dark.json"), [
    "pack/extensions/meter.ts",
    "pack/lib/money.ts",
    "pack/themes/dark.json",
  ]);
  assert.deepEqual(shipped("config/agents/writer.md", "config/models.json"), ["config/agents/writer.md", "config/models.json"], "a .md file can still ship");
  assert.deepEqual(shipped("scripts/pi-build.cjs", "package.json", "package-lock.json", "pack/package.json").length, 4);
  // None of these end up in the package, or are only documentation.
  assert.deepEqual(shipped("pack/test/meter.test.ts", "docs/demo.gif", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "CONTRIBUTING.md"), []);
  assert.deepEqual(shipped(".github/workflows/test.yml", "scripts/release.cjs", "relay/src/index.ts"), []);
  assert.deepEqual(shipped("", "  "), []);
  assert.deepEqual(shipped("pack\\lib\\money.ts", "./bin/nusacode.js"), ["pack\\lib\\money.ts", "./bin/nusacode.js"], "Windows separators and ./ are understood");
  assert.deepEqual(shipped("packaging/x", "binary/x"), [], "a folder name is not a prefix of a longer name");
});

test("what ships is read from package.json's files list, not a second copy", () => {
  const shipped = shippedPaths(manifest);
  assert.ok(shipped.includes("bin") && shipped.includes("pack/extensions") && shipped.includes("package-lock.json"));
  assert.ok(!shipped.includes("README.md") && !shipped.includes("CHANGELOG.md"));
  assert.deepEqual(shippedPaths({ files: ["a", "README.md"] }), ["a", "package.json", "package-lock.json"]);
  assert.deepEqual(shippedPaths({}), ["package.json", "package-lock.json"]);
});

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "- Something new.",
  "",
  "## [0.2.0] - 2026-12-01",
  "",
  "### Changed",
  "- A change.",
  "",
  "## [0.1.0] - 2026-11-06",
  "",
  "First public release.",
  "",
].join("\n");

test("a version's section is its changelog entry, without the heading", () => {
  assert.equal(changelogSection(changelog, "0.2.0"), "### Changed\n- A change.");
  assert.equal(changelogSection(changelog, "0.1.0"), "First public release.");
  assert.equal(changelogSection(changelog, "0.3.0"), null);
  assert.equal(changelogSection(changelog, "0.2"), null, "no partial matches");
  assert.equal(changelogSection(changelog.replace(/\n/g, "\r\n"), "0.2.0"), "### Changed\n- A change.", "Windows line endings");
  assert.equal(changelogSection("## [1.0.0]\n\n## [0.9.0]\nx", "1.0.0"), null, "an empty section is no notes");
  assert.equal(changelogSection(changelog, "0.1.0".replace(".", "x")), null, "dots are not wildcards");
});

test("the real changelog has a section for the first release", () => {
  const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelogSection(text, "0.1.0") ?? "", /First public release/);
});

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });
}

test("the command line gives the answers the workflow acts on", () => {
  assert.deepEqual([run(["next", "0.1.0", "0.1.4"]).stdout.trim(), run(["next", "0.1.0", "0.1.4"]).status], ["0.1.5", 0]);

  const changed = run(["publishable"], "pack/lib/money.ts\nREADME.md\npack/test/a.test.ts\n");
  assert.equal(changed.status, 0);
  assert.equal(changed.stdout.trim(), "pack/lib/money.ts");

  const docsOnly = run(["publishable"], "README.md\ndocs/demo.gif\n");
  assert.equal(docsOnly.status, 1, "exit 1 means nothing to ship, which is not an error");
  assert.equal(docsOnly.stdout, "");
  assert.equal(run(["publishable"], "").status, 1);

  assert.equal(run(["notes", "0.1.0"]).status, 0);
  assert.equal(run(["notes", "9.9.9"]).status, 1);

  const bad = run(["next", "not-a-version", "0.1.0"]);
  assert.equal(bad.status, 2, "a real error is exit 2, so the workflow can tell it from 'nothing to ship'");
  assert.match(bad.stderr, /not a plain x\.y\.z version/);
  assert.equal(run(["bogus"]).status, 2);
});

test("the publish workflow is valid YAML, skips quietly when nothing ships, and only tags after publishing", () => {
  const text = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");
  const workflow = parse(text);
  const steps: { name?: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown> }[] = workflow.jobs.publish.steps;

  assert.equal(workflow.permissions.contents, "write", "tags and releases need write access");
  assert.equal(workflow.permissions["id-token"], "write", "provenance");
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout"));
  assert.equal(checkout?.with?.["fetch-depth"], 0, "the last release tag has to be visible");

  const indexOf = (needle: string) => steps.findIndex((step) => (step.run ?? "").includes(needle));
  const decide = indexOf("release.cjs publishable");
  const publish = indexOf("npm publish");
  const tag = indexOf("git tag");
  assert.ok(decide >= 0 && decide < publish && publish < tag, "decide, then publish, then tag");
  for (const step of steps.slice(decide + 1)) {
    assert.match(step.if ?? "", /steps\.changes\.outputs\.publish == 'true'/, `"${step.name ?? step.run}" must be skipped with the publish`);
  }
  assert.match(steps[decide].run ?? "", /exit 1/, "a failure of the script itself is an error, not a skip");
  assert.match(steps[tag].run ?? "", /gh release create/);
});
