"use strict";
/**
 * Builds NusaCode's own copy of pi: the pinned pi package with a handful of small
 * patches, so what users see says NusaCode instead of pi. Each change is made twice:
 * in pi's separate source files, and in the bundle that pi actually starts from.
 *
 * Why a copy and not a fork: pi is pinned to one exact version, so a patch list is far
 * less to maintain than a fork, and the tests fail loudly if a patch stops matching.
 * The copy lives next to this package (vendor/pi), so its imports still resolve from this
 * package's node_modules.
 *
 * What changes:
 *   - the app name, config folder and window title ("NSC - <session name>")
 *   - /bug opens a GitHub issue with details filled in, instead of uploading the
 *     session transcript to pi's developers
 *   - /changelog shows NusaCode's CHANGELOG.md
 *   - the system prompt and a few hints say NusaCode
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REPO_URL = "https://github.com/RafiAkem/nusacode";
const TITLE = "NSC";

/** Replaces `find` with `replacement`, and fails unless `find` occurs exactly once. */
function replaceOnce(source, find, replacement, label) {
  const at = source.indexOf(find);
  if (at < 0 || source.indexOf(find, at + 1) >= 0) throw new Error(`pi patch "${label}" did not match exactly once`);
  return source.slice(0, at) + replacement + source.slice(at + find.length);
}

/** Replaces everything from `start` up to (not including) `end`. */
function replaceBetween(source, start, end, replacement, label) {
  const from = source.indexOf(start);
  const to = from < 0 ? -1 : source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`pi patch "${label}" did not match`);
  return source.slice(0, from) + replacement + source.slice(to);
}

const BUG_COMMAND = `    async handleBugCommand(hint) {
        // NusaCode: open a prefilled GitHub issue. Nothing from the session is uploaded.
        const model = this.session.model;
        const params = new URLSearchParams({
            template: "bug_report.yml",
            title: hint ?? "",
            version: VERSION,
            environment: \`\${process.platform} \${process.arch}, Node \${process.versions.node}\`,
            provider: model ? \`\${model.provider}/\${model.id}\` : "",
        });
        const url = \`${REPO_URL}/issues/new?\${params}\`;
        const { spawn } = await import("node:child_process");
        const [command, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
        try {
            const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
            child.on("error", () => { });
            child.unref();
        }
        catch { }
        this.showStatus(\`Opening a bug report on GitHub. If nothing opens, go to \${url}\`);
    }
`;

/** The source patches: file (relative to the pi package) and how to change it. */
const patches = [
  {
    file: "dist/config.js",
    apply: (s) =>
      replaceOnce(
        s,
        'export const APP_TITLE = piConfigName ? APP_NAME : "π";',
        'export const APP_TITLE = pkg.piConfig?.title || (piConfigName ? APP_NAME : "π");',
        "app title",
      ),
  },
  {
    file: "dist/modes/interactive/interactive-mode.js",
    apply: (s) => {
      s = replaceOnce(s, "`${APP_TITLE} - ${sessionName} - ${cwdBasename}`", "`${APP_TITLE} - ${sessionName}`", "window title");
      s = replaceBetween(s, "    async handleBugCommand(hint) {", "    async handleCopyCommand(", BUG_COMMAND, "/bug");
      s = replaceOnce(s, " Run /bug to report it; the crash details are attached automatically.", " Run /bug to report it.", "crash hint");
      s = replaceOnce(s, " run /bug. The crash details are attached automatically.`", " run /bug.`", "crash instructions");
      s = replaceOnce(s, '"start pi and"', '"start nusacode and"', "start hint");
      return replaceOnce(s, "/bug sends a report to the developers.", "/bug opens a bug report on GitHub.", "bug hint");
    },
  },
  {
    file: "dist/core/slash-commands.js",
    apply: (s) => replaceOnce(s, "Report a bug to the Pi developers", "Report a bug to NusaCode on GitHub", "/bug description"),
  },
  {
    file: "dist/core/system-prompt.js",
    apply: (s) =>
      replaceOnce(
        s,
        "You are a coding assistant running inside pi, a coding agent harness.",
        "You are a coding assistant running inside NusaCode, a coding agent harness built on pi.",
        "system prompt",
      ),
  },
];

/**
 * The same changes for the bundle. pi 1.5.0 starts from dist/bundle/cli.js, which holds its own
 * copy of all the code, so the files above are only what pi's SDK exports and what extensions
 * import; what the user actually runs is the bundle. Its code is whitespace-minified but keeps
 * its identifiers and strings, so each patch anchors on text that is stable within a pi version.
 * Chunk file names carry a content hash, so a patch finds its file by searching every bundle file
 * for its anchor, and fails unless exactly one file holds it exactly once.
 */
const bundlePatches = [
  {
    label: "app title",
    find: 'APP_TITLE=piConfigName?APP_NAME:"\\u03C0"',
    replace: 'APP_TITLE=pkg.piConfig?.title||(piConfigName?APP_NAME:"\\u03C0")',
  },
  { label: "window title", find: "`${APP_TITLE} - ${sessionName} - ${cwdBasename}`", replace: "`${APP_TITLE} - ${sessionName}`" },
  // The bundled method only calls reportBug(), the flow that uploads the session; it is the only
  // caller, so replacing the method leaves that flow unreachable.
  { label: "/bug", between: ["async handleBugCommand(hint){", "async handleCopyCommand("], replace: BUG_COMMAND },
  { label: "crash hint", find: " Run /bug to report it; the crash details are attached automatically.", replace: " Run /bug to report it." },
  { label: "crash instructions", find: " run /bug. The crash details are attached automatically.`", replace: " run /bug.`" },
  { label: "start hint", find: '"start pi and"', replace: '"start nusacode and"' },
  { label: "bug hint", find: "/bug sends a report to the developers.", replace: "/bug opens a bug report on GitHub." },
  { label: "/bug description", find: "Report a bug to the Pi developers", replace: "Report a bug to NusaCode on GitHub" },
  {
    label: "system prompt",
    find: "You are a coding assistant running inside pi, a coding agent harness.",
    replace: "You are a coding assistant running inside NusaCode, a coding agent harness built on pi.",
  },
];

const BUNDLE_DIR = path.join("dist", "bundle");

/** Every .js file under the bundle folder, relative to the pi package. */
function bundleFiles(piDir) {
  const out = [];
  const walk = (rel) => {
    const full = path.join(piDir, rel);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".js")) out.push(child);
    }
  };
  walk(BUNDLE_DIR);
  return out.sort();
}

/**
 * Applies the bundle patches to the bundle in `piDir`, in memory. Returns the files that changed
 * and one failure per patch that no longer matches; it never writes anything.
 */
function patchBundle(piDir) {
  const files = new Map(bundleFiles(piDir).map((file) => [file, fs.readFileSync(path.join(piDir, file), "utf8")]));
  const changed = new Map();
  const failures = [];
  if (files.size === 0) return { changed, failures: [{ label: "bundle", error: `there is no ${BUNDLE_DIR.replace(/\\/g, "/")} folder` }] };
  for (const patch of bundlePatches) {
    const anchor = patch.find ?? patch.between[0];
    const holders = [...files.keys()].filter((file) => (changed.get(file) ?? files.get(file)).includes(anchor));
    if (holders.length !== 1) {
      failures.push({ label: patch.label, error: `pi patch "${patch.label}" ${holders.length === 0 ? "matched no bundle file" : `matched ${holders.length} bundle files`}` });
      continue;
    }
    const file = holders[0];
    const source = changed.get(file) ?? files.get(file);
    try {
      const next = patch.find
        ? replaceOnce(source, patch.find, patch.replace, patch.label)
        : replaceBetween(source, patch.between[0], patch.between[1], patch.replace, patch.label);
      changed.set(file, next);
    } catch (err) {
      failures.push({ label: patch.label, error: err.message });
    }
  }
  return { changed, failures };
}

/** Everything that decides what the build contains, so a stale copy is noticed. */
function stamp(piDir, nusacodeDir) {
  const hash = crypto.createHash("sha256");
  // Versions, not file bytes: npm rewrites package.json when publishing.
  hash.update(JSON.parse(fs.readFileSync(path.join(piDir, "package.json"), "utf8")).version);
  hash.update(JSON.parse(fs.readFileSync(path.join(nusacodeDir, "package.json"), "utf8")).version);
  hash.update(fs.readFileSync(__filename));
  const changelog = path.join(nusacodeDir, "CHANGELOG.md");
  if (fs.existsSync(changelog)) hash.update(fs.readFileSync(changelog));
  return hash.digest("hex").slice(0, 16);
}

/** Copies pi to `target`, applies every patch, and writes the stamp last. */
function buildPi({ piDir, nusacodeDir, target }) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(piDir, target, { recursive: true, filter: (src) => !src.endsWith(".map") && (path.basename(src) !== "node_modules" || path.dirname(src) !== piDir) });

  for (const { file, apply } of patches) {
    const full = path.join(target, file);
    fs.writeFileSync(full, apply(fs.readFileSync(full, "utf8")));
  }
  const bundle = patchBundle(target);
  if (bundle.failures.length > 0) throw new Error(bundle.failures.map((failure) => failure.error).join("; "));
  for (const [file, source] of bundle.changed) fs.writeFileSync(path.join(target, file), source);

  const manifestPath = path.join(target, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const own = JSON.parse(fs.readFileSync(path.join(nusacodeDir, "package.json"), "utf8"));
  manifest.name = own.name;
  manifest.version = own.version;
  manifest.piConfig = { name: "nusacode", configDir: ".nusacode", title: TITLE };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const changelog = path.join(nusacodeDir, "CHANGELOG.md");
  if (fs.existsSync(changelog)) fs.copyFileSync(changelog, path.join(target, "CHANGELOG.md"));

  fs.writeFileSync(path.join(target, ".nusacode-build"), stamp(piDir, nusacodeDir));
}

/** True when `target` was built from exactly this pi and this package. */
function isCurrent({ piDir, nusacodeDir, target }) {
  try {
    return fs.readFileSync(path.join(target, ".nusacode-build"), "utf8") === stamp(piDir, nusacodeDir);
  } catch {
    return false;
  }
}

module.exports = { buildPi, bundleFiles, bundlePatches, isCurrent, patchBundle, patches, replaceOnce, REPO_URL, TITLE };
