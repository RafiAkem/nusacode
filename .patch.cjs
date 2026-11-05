const fs = require("fs");
const p = "bin/nusacode.js";
let s = fs.readFileSync(p, "utf8");
const rep = (a, b) => { if (!s.includes(a)) throw new Error("missing: " + a.slice(0, 60)); s = s.replace(a, () => b); };
rep('lastChangelogVersion: require(path.join(piPackageDir(), "package.json")).version,', 'lastChangelogVersion: require(path.join(root, "package.json")).version,');
rep(`function piCli() {
  const dir = piPackageDir();
  return path.join(dir, require(path.join(dir, "package.json")).bin.pi);
}`, `// NusaCode runs its own patched copy of pi (see scripts/pi-build.cjs), built once and kept
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
    console.error(\`nusacode: could not prepare its patched pi (\${err.message}); running stock pi.\`);
    patchedPi = stock;
  }
  return patchedPi;
}

function piCli() {
  const dir = piDirectory();
  return path.join(dir, require(path.join(dir, "package.json")).bin.pi);
}`);
rep(`  env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_SKIP_VERSION_CHECK: "1" },`, `  env: {
    ...process.env,
    // The patched pi reads the first name; the stock pi the second.
    NUSACODE_CODING_AGENT_DIR: home,
    PI_CODING_AGENT_DIR: home,
    PI_SKIP_VERSION_CHECK: "1",
    // pi pings its own servers about installs and tags requests as coming from pi.
    PI_TELEMETRY: "0",
  },`);
fs.writeFileSync(p, s);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.files = ["bin", "config", "scripts/pi-build.cjs", "scripts/build-vendor.cjs", "vendor", "pack/package.json", "pack/extensions", "pack/lib", "pack/themes", "CHANGELOG.md", "LICENSE", "NOTICE", "README.md"];
pkg.scripts = { ...pkg.scripts, prepack: "node scripts/build-vendor.cjs" };
pkg.dependencies["@earendil-works/pi-coding-agent"] = "1.5.0";
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

fs.appendFileSync(".gitignore", "\n# NusaCode's patched copy of pi, built by the launcher and before publishing\n/vendor/\n");
