import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkApiKey, findSkills, importLabels, importSource, saveApiKey, scanSources, setupIsDone, verifyApiKey } from "../extensions/setup.ts";

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-setup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(path: string, text = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function skill(root: string, name: string): void {
  write(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`);
}

test("findSkills finds nested skills and ignores trash and dot folders", (t) => {
  const root = tempDir(t);
  skill(root, "top");
  skill(join(root, "synced", "abc"), "nested");
  skill(join(root, ".trash", "123"), "deleted");
  write(join(root, "not-a-skill", "notes.md"));
  write(join(root, "archive.rar"));
  assert.deepEqual(findSkills(root).map((s) => s.name), ["nested", "top"]);
  assert.deepEqual(findSkills(join(root, "missing")), []);
});

test("sources are found per agent, and empty instruction files don't count", (t) => {
  const home = tempDir(t);
  skill(join(home, ".claude", "skills"), "alpha");
  write(join(home, ".claude", "CLAUDE.md"), "be brief");
  write(join(home, ".codex", "AGENTS.md"), "   ");
  const sources = scanSources(home, join(home, "dest"));
  assert.deepEqual(sources.map((s) => [s.label, s.skills.map((x) => x.name), s.instructions !== null]), [
    ["Claude Code", ["alpha"], true],
  ]);
});

test("names already installed, loaded by pi, or seen in an earlier agent aren't offered", (t) => {
  const home = tempDir(t);
  const dest = join(home, "dest");
  skill(dest, "installed");
  skill(join(home, ".agents", "skills"), "shared");
  for (const name of ["installed", "shared", "dup", "Bad_Name", "fresh"]) skill(join(home, ".claude", "skills"), name);
  skill(join(home, ".codex", "skills"), "dup");
  assert.deepEqual(scanSources(home, dest).map((s) => [s.label, s.skills.map((x) => x.name)]), [
    ["Claude Code", ["dup", "fresh"]],
  ]);
});

test("importLabels copies only the picked agents, and a skill an unpicked agent shares still comes over", (t) => {
  const home = tempDir(t);
  const dest = join(home, "dest");
  skill(join(home, ".claude", "skills"), "shared");
  skill(join(home, ".claude", "skills"), "claude-only");
  skill(join(home, ".codex", "skills"), "shared");
  const reports = importLabels(["Codex"], home, dest);
  assert.deepEqual(reports, [{ label: "Codex", imported: ["shared"], skipped: [], instructions: false }]);
  assert.equal(existsSync(join(dest, "skills", "claude-only")), false);
});

test("import copies a skill but not its dot files, and never overwrites", (t) => {
  const home = tempDir(t);
  const root = join(home, ".claude", "skills");
  skill(root, "alpha");
  write(join(root, "alpha", "scripts", "run.sh"), "echo hi");
  write(join(root, "alpha", ".env"), "SECRET=1");
  const dest = join(home, "dest");
  skill(join(dest, "skills"), "existing");
  const source = {
    label: "Claude Code",
    skills: [
      { name: "alpha", dir: join(root, "alpha") },
      { name: "existing", dir: join(root, "alpha") },
    ],
    instructions: null,
  };
  assert.deepEqual(importSource(source, dest), { imported: ["alpha"], skipped: ["existing"], instructions: false });
  assert.equal(readFileSync(join(dest, "skills", "alpha", "scripts", "run.sh"), "utf8"), "echo hi");
  assert.equal(existsSync(join(dest, "skills", "alpha", ".env")), false);
  assert.ok(readFileSync(join(dest, "skills", "existing", "SKILL.md"), "utf8").includes("name: existing"));
});

test("an oversized skill is skipped", (t) => {
  const home = tempDir(t);
  const dir = join(home, "big");
  write(join(dir, "SKILL.md"));
  writeFileSync(join(dir, "blob"), Buffer.alloc(5_000_001));
  const result = importSource({ label: "x", skills: [{ name: "big", dir }], instructions: null }, join(home, "dest"));
  assert.deepEqual(result.skipped, ["big"]);
  assert.equal(existsSync(join(home, "dest", "skills", "big")), false);
});

test("the first instructions file wins and an existing one is kept", (t) => {
  const home = tempDir(t);
  const dest = join(home, "dest");
  write(join(home, "a.md"), "first");
  write(join(home, "b.md"), "second");
  const from = (file: string) => ({ label: "x", skills: [], instructions: join(home, file) });
  assert.equal(importSource(from("a.md"), dest).instructions, true);
  assert.equal(importSource(from("b.md"), dest).instructions, false);
  assert.equal(readFileSync(join(dest, "AGENTS.md"), "utf8"), "first");
});

test("saveApiKey keeps other credentials and refuses a file it can't parse", (t) => {
  const dir = tempDir(t);
  write(join(dir, "auth.json"), JSON.stringify({ other: { type: "api_key", key: "keep" } }));
  assert.equal(saveApiKey(dir, "nsk_new"), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")), {
    other: { type: "api_key", key: "keep" },
    nusagate: { type: "api_key", key: "nsk_new" },
  });
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "auth.json")).mode & 0o777, 0o600);

  write(join(dir, "auth.json"), "{ not json");
  assert.equal(saveApiKey(dir, "nsk_new"), false);
  assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), "{ not json");
});

test("checkApiKey separates a bad key from a gateway problem", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const respond = (status: number) => {
    globalThis.fetch = (async () => new Response("{}", { status })) as typeof fetch;
  };
  respond(200);
  assert.equal(await checkApiKey("k"), "ok");
  respond(401);
  assert.equal(await checkApiKey("k"), "rejected");
  respond(503);
  assert.equal(await checkApiKey("k"), "unreachable");
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.equal(await checkApiKey("k"), "unreachable");
});

test("verifyApiKey brings the balance back when the gateway sends one", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async () => new Response(JSON.stringify({ balance: 42_500 }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await verifyApiKey("k"), { status: "ok", balanceIdr: 42_500 });
  globalThis.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
  assert.deepEqual(await verifyApiKey("k"), { status: "ok" });
});

test("setupIsDone reads the marker and treats anything else as not done", (t) => {
  const dir = tempDir(t);
  assert.equal(setupIsDone(dir), false);
  write(join(dir, "setup.json"), "garbage");
  assert.equal(setupIsDone(dir), false);
  write(join(dir, "setup.json"), JSON.stringify({ version: 1 }));
  assert.equal(setupIsDone(dir), true);
});
