"use strict";
/**
 * Builds NusaCode's own copy of pi: the pinned pi package with a handful of small
 * source patches, so what users see says NusaCode instead of pi.
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

module.exports = { buildPi, isCurrent, patches, replaceOnce, REPO_URL, TITLE };
