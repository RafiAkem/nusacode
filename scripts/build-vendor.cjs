"use strict";
// Builds vendor/pi before `npm pack` / `npm publish`, so installs never have to build it.
const fs = require("node:fs");
const path = require("node:path");
const { buildPi } = require("./pi-build.cjs");

const root = path.join(__dirname, "..");

/** Walks up from this package, like the launcher does, to find the installed pi. */
function findPi() {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) throw new Error("@earendil-works/pi-coding-agent is not installed; run npm install");
  }
}

buildPi({ piDir: findPi(), nusacodeDir: root, target: path.join(root, "vendor", "pi") });
console.log("Built vendor/pi");
