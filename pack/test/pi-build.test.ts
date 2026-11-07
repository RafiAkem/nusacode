import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..", "..");
const { buildPi, bundleFiles, isCurrent, replaceOnce } = require(join(root, "scripts", "pi-build.cjs"));
const piDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");

/** One build shared by the tests that only read it. */
const target = mkdtempSync(join(tmpdir(), "nusacode-pi-"));
const options = { piDir, nusacodeDir: root, target };
buildPi(options);
test.after(() => rmSync(target, { recursive: true, force: true }));

const read = (file: string) => readFileSync(join(target, file), "utf8");

// The weekly upgrade check (.github/workflows/pi-upgrade.yml) installs a newer pi on purpose, and
// what it needs to learn is whether the patches still apply, which the build above already proves.
const upgradeCheck = process.env.NUSACODE_PI_UPGRADE_CHECK === "1";

test("every patch still matches the pinned pi (a pi bump that breaks one fails here)", { skip: upgradeCheck && "checking a newer pi on purpose" }, () => {
  // buildPi above would have thrown; this pins the version the patches were written for.
  assert.equal(JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).version, "1.5.0");
});

test("the copy is named NusaCode and carries NusaCode's version", () => {
  const manifest = JSON.parse(read("package.json"));
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "nusacode");
  assert.equal(manifest.version, own.version);
  assert.deepEqual(manifest.piConfig, { name: "nusacode", configDir: ".nusacode", title: "NSC" });
});

test("the window title is NSC and the session name, without the folder", () => {
  assert.match(read("dist/config.js"), /pkg\.piConfig\?\.title/);
  const mode = read("dist/modes/interactive/interactive-mode.js");
  assert.ok(mode.includes("`${APP_TITLE} - ${sessionName}`"));
  assert.ok(!mode.includes("${sessionName} - ${cwdBasename}"));
});

test("/bug opens a GitHub issue and uploads nothing", () => {
  const mode = read("dist/modes/interactive/interactive-mode.js");
  const start = mode.indexOf("async handleBugCommand(hint)");
  const body = mode.slice(start, mode.indexOf("async handleCopyCommand(", start));
  assert.ok(body.includes("github.com/RafiAkem/nusacode/issues/new"));
  assert.ok(body.includes("template: \"bug_report.yml\""));
  assert.ok(!body.includes("reportBug"), "no upload flow");
  assert.ok(!mode.includes("the crash details are attached automatically"));
  assert.match(read("dist/core/slash-commands.js"), /Report a bug to NusaCode on GitHub/);
});

test("/changelog shows NusaCode's changelog and the model is told it runs in NusaCode", () => {
  assert.equal(read("CHANGELOG.md"), readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  assert.match(read("dist/core/system-prompt.js"), /running inside NusaCode, a coding agent harness built on pi/);
});

/** The bundle file holding `text`; the bundle is what pi actually runs. */
function bundleWith(text: string): string {
  const holders = bundleFiles(target)
    .map((file: string) => read(file))
    .filter((source: string) => source.includes(text));
  assert.equal(holders.length, 1, `exactly one bundle file holds ${JSON.stringify(text)}`);
  return holders[0]!;
}

test("the bundle pi runs from carries every change too", () => {
  assert.ok(bundleWith('APP_TITLE=pkg.piConfig?.title||(piConfigName?APP_NAME:"\\u03C0")'));
  const app = bundleWith("async handleBugCommand(hint)");
  assert.ok(app.includes("`${APP_TITLE} - ${sessionName}`") && !app.includes("${sessionName} - ${cwdBasename}"), "window title");
  const start = app.indexOf("async handleBugCommand(hint)");
  const body = app.slice(start, app.indexOf("async handleCopyCommand(", start));
  assert.ok(body.includes("github.com/RafiAkem/nusacode/issues/new"), "/bug opens a GitHub issue");
  assert.ok(!body.includes("reportBug"), "/bug no longer reaches the upload flow");
  assert.equal(app.split("reportBug(").length - 1, 1, "only the unused definition of reportBug is left");
  assert.ok(!app.includes("the crash details are attached automatically"));
  assert.ok(!app.includes("Report a bug to the Pi developers"));
  assert.ok(app.includes("running inside NusaCode, a coding agent harness built on pi"));
});

test("pi's pickers wrap round instead of stopping at the ends, so one held arrow key reaches everything", () => {
  const components = "dist/modes/interactive/components";
  for (const [name, list] of [
    ["extension-selector", "this.options"],
    ["session-selector", "this.filteredSessions"],
    ["oauth-selector", "this.filteredProviders"],
    ["trust-selector", "this.trustOptions"],
  ]) {
    const source = read(`${components}/${name}.js`);
    assert.ok(!source.includes("Math.max(0, this.selectedIndex - 1)"), `${name}: up no longer stops at the top`);
    assert.ok(source.includes(`this.selectedIndex<${list}.length-1?this.selectedIndex+1:0`), `${name}: down wraps to the top`);
  }
  assert.ok(!read(`${components}/first-time-setup.js`).includes("Math.max(0, Math.min("), "the first-run choices wrap");

  const app = bundleWith("this.selectedIndex<this.trustOptions.length-1?this.selectedIndex+1:0");
  assert.ok(!app.includes("this.selectedIndex=Math.max(0,this.selectedIndex-1)"), "no stopping list left in the bundle");
  assert.ok(!app.includes("Math.max(0,Math.min(THEME_OPTIONS.length-1"));

  // The expressions themselves: down past the last goes to the first, up past the first to the last.
  const picker = { selectedIndex: 2, options: ["a", "b", "c"] };
  const step = (code: string) => new Function(code).call(picker);
  step("this.selectedIndex=this.selectedIndex<this.options.length-1?this.selectedIndex+1:0");
  assert.equal(picker.selectedIndex, 0);
  step("this.selectedIndex=this.selectedIndex>0?this.selectedIndex-1:Math.max(0,this.options.length-1)");
  assert.equal(picker.selectedIndex, 2);
});

test("a patched bundle still parses", () => {
  for (const file of bundleFiles(target)) {
    const result = spawnSync(process.execPath, ["--check", join(target, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test("the build is current until its inputs change", () => {
  assert.equal(isCurrent(options), true);
  const stale = mkdtempSync(join(tmpdir(), "nusacode-pi-stale-"));
  try {
    assert.equal(isCurrent({ ...options, target: stale }), false, "an empty folder is not a build");
    writeFileSync(join(target, ".nusacode-build"), "something else");
    assert.equal(isCurrent(options), false);
    writeFileSync(join(target, ".nusacode-build"), "x");
    buildPi(options);
    assert.equal(isCurrent(options), true);
  } finally {
    rmSync(stale, { recursive: true, force: true });
  }
});

test("replaceOnce refuses a missing or ambiguous match", () => {
  assert.equal(replaceOnce("a b c", "b", "X", "t"), "a X c");
  assert.throws(() => replaceOnce("a b c", "z", "X", "t"), /did not match exactly once/);
  assert.throws(() => replaceOnce("b b", "b", "X", "t"), /did not match exactly once/);
});
