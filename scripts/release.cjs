"use strict";
/**
 * The decisions behind .github/workflows/publish.yml, kept here so they can be tested.
 *
 *   node scripts/release.cjs next <package.json version> <version on npm>
 *       prints the version to publish
 *   git diff --name-only <last tag> HEAD | node scripts/release.cjs publishable
 *       prints the changed files that end up in the npm package; exits 1 when there are none
 *   node scripts/release.cjs notes <version> [<CHANGELOG.md as it was at the last release>]
 *       prints the release notes: that version's section of CHANGELOG.md, or else the entries
 *       added under "Unreleased" since the last release; exits 1 when there are none
 */
const fs = require("node:fs");
const path = require("node:path");

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!match) throw new Error(`"${version}" is not a plain x.y.z version`);
  return match.slice(1).map(Number);
}

/**
 * The version to publish: package.json's when it is higher than what npm has (that is how a
 * minor or major release is asked for), otherwise the next patch after npm's.
 */
function nextVersion(repo, live) {
  const r = parse(repo);
  const l = parse(live);
  const higher = r[0] - l[0] || r[1] - l[1] || r[2] - l[2];
  return higher > 0 ? r.join(".") : [l[0], l[1], l[2] + 1].join(".");
}

/** Files in the package that are only documentation: changing them alone is no reason to release. */
const DOCS = new Set(["README.md", "CHANGELOG.md", "LICENSE", "NOTICE"]);

/** What ships, from package.json's own `files` list, plus the files that decide what gets installed. */
function shippedPaths(manifest) {
  const listed = (manifest.files ?? []).filter((entry) => !DOCS.has(entry));
  return [...listed, "package.json", "package-lock.json"];
}

function isShipped(file, shipped) {
  const normal = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return shipped.some((entry) => normal === entry || normal.startsWith(`${entry.replace(/\/$/, "")}/`));
}

/** The changed files that would reach users. */
function shippedChanges(files, manifest) {
  const shipped = shippedPaths(manifest);
  return files.map((file) => file.trim()).filter((file) => file && isShipped(file, shipped));
}

/** The body of `## [version]` in a changelog, without the heading, or null when it is missing or empty. */
function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \[/.test(line));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body === "" ? null : body;
}

/**
 * The `## [Unreleased]` section as entries: each `- ` bullet (with any indented lines that
 * continue it) under the `### ` heading it sits in.
 */
function unreleasedEntries(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^## \[Unreleased\]/i.test(line));
  if (start < 0) return [];
  const entries = [];
  let heading = "";
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    if (/^### /.test(line)) heading = line.slice(4).trim();
    else if (/^[-*] /.test(line)) entries.push({ heading, text: line.trimEnd() });
    else if (/^\s+\S/.test(line) && entries.length > 0) entries[entries.length - 1].text += `\n${line.trimEnd()}`;
  }
  return entries;
}

/**
 * Release notes from the changelog entries added since the last release: the entries under
 * `## [Unreleased]` now that weren't there in `previous` (the changelog at the last release tag),
 * grouped under their headings. Nobody has to move entries into a version section by hand, and an
 * entry shows up in exactly one release. Null when nothing new was written.
 */
function newEntriesNotes(current, previous) {
  const seen = new Set(unreleasedEntries(previous).map((entry) => entry.text));
  const fresh = unreleasedEntries(current).filter((entry) => !seen.has(entry.text));
  if (fresh.length === 0) return null;
  const groups = new Map();
  for (const entry of fresh) groups.set(entry.heading, [...(groups.get(entry.heading) ?? []), entry.text]);
  return [...groups]
    .map(([heading, texts]) => (heading ? `### ${heading}\n${texts.join("\n")}` : texts.join("\n")))
    .join("\n\n");
}

/** A version's own section when it has one, otherwise what was added to Unreleased since `previous`. */
function releaseNotes(current, version, previous) {
  return changelogSection(current, version) ?? (previous === undefined ? null : newEntriesNotes(current, previous));
}

function main(argv) {
  const root = path.join(__dirname, "..");
  const [command, ...args] = argv;
  if (command === "next") {
    console.log(nextVersion(args[0], args[1]));
    return 0;
  }
  if (command === "publishable") {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const changed = shippedChanges(fs.readFileSync(0, "utf8").split("\n"), manifest);
    if (changed.length === 0) return 1;
    console.log(changed.join("\n"));
    return 0;
  }
  if (command === "notes") {
    const current = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    const previous = args[1] === undefined ? undefined : fs.existsSync(args[1]) ? fs.readFileSync(args[1], "utf8") : "";
    const notes = releaseNotes(current, args[0] ?? "", previous);
    if (notes === null) return 1;
    console.log(notes);
    return 0;
  }
  console.error("usage: release.cjs next <repo> <live> | publishable | notes <version> [<changelog at the last release>]");
  return 2;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}

module.exports = { nextVersion, shippedPaths, shippedChanges, changelogSection, unreleasedEntries, newEntriesNotes, releaseNotes };
