import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Checkpoints, MAX_TURNS, resolveToolPath } from "../lib/checkpoints.ts";
import undo from "../extensions/undo.ts";

function workdir(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "nusacode-undo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** What a file tool does around a change: remember, change, then record the result. */
function edit(cp: Checkpoints, path: string, content: string | null) {
  cp.before(path);
  if (content === null) rmSync(path, { force: true });
  else writeFileSync(path, content);
  cp.after(path);
}

test("tool paths are read like pi reads them", () => {
  assert.equal(resolveToolPath("src/a.ts", "/work"), resolve("/work", "src/a.ts"));
  assert.equal(resolveToolPath("@src/a.ts", "/work"), resolve("/work", "src/a.ts"));
  assert.equal(resolveToolPath("~/notes.txt", "/work"), resolve(homedir(), "notes.txt"));
  assert.equal(resolveToolPath("~", "/work"), homedir());
  assert.equal(resolveToolPath(resolve("/abs/x"), "/work"), resolve("/abs/x"));
});

test("undo puts back an edited file and deletes a created one", (t) => {
  const dir = workdir(t);
  const old = join(dir, "old.txt");
  const fresh = join(dir, "new", "fresh.txt");
  writeFileSync(old, "original");
  mkdirSync(join(dir, "new"));

  const cp = new Checkpoints();
  cp.startTurn("fix things");
  edit(cp, old, "changed");
  edit(cp, old, "changed again"); // a second edit in the same prompt still undoes to the original
  edit(cp, fresh, "brand new");

  const latest = cp.latest();
  assert.equal(latest?.label, "fix things");
  assert.deepEqual(latest?.changes.map((c) => [c.kind, c.conflict]), [["modified", false], ["created", false]]);

  const result = cp.undoLatest();
  assert.deepEqual(result, { restored: [old], deleted: [fresh], failed: [], skipped: [] });
  assert.equal(readFileSync(old, "utf8"), "original");
  assert.equal(existsSync(fresh), false);
  assert.equal(cp.latest(), null, "an undone prompt is forgotten");
  assert.equal(cp.undoLatest(), null);
});

test("each undo goes one prompt further back", (t) => {
  const dir = workdir(t);
  const file = join(dir, "f.txt");
  writeFileSync(file, "v0");
  const cp = new Checkpoints();
  cp.startTurn("one");
  edit(cp, file, "v1");
  cp.startTurn("two");
  edit(cp, file, "v2");
  assert.deepEqual(cp.history().map((entry) => entry.label), ["two", "one"]);

  cp.undoLatest();
  assert.equal(readFileSync(file, "utf8"), "v1");
  assert.equal(cp.latest()?.label, "one");
  assert.equal(cp.latest()?.changes[0].conflict, false, "the older prompt's result is what is on disk again");
  cp.undoLatest();
  assert.equal(readFileSync(file, "utf8"), "v0");
});

test("a prompt that changed nothing, or whose call was blocked, is not an undo step", (t) => {
  const dir = workdir(t);
  const file = join(dir, "f.txt");
  writeFileSync(file, "same");
  const cp = new Checkpoints();
  cp.startTurn("only reads");
  cp.startTurn("blocked");
  cp.before(file); // a tool_call that another extension then blocked: the file never changed
  cp.after(file);
  cp.startTurn("same content written");
  edit(cp, file, "same");
  assert.equal(cp.latest(), null);
  assert.deepEqual(cp.history(), []);

  cp.startTurn("never finished");
  cp.before(file);
  writeFileSync(file, "half way");
  assert.equal(cp.latest(), null, "no result was recorded, so there is nothing certain to undo");
});

test("a file changed again after the agent wrote it is flagged, not silently overwritten", (t) => {
  const dir = workdir(t);
  const file = join(dir, "f.txt");
  writeFileSync(file, "original");
  const cp = new Checkpoints();
  cp.startTurn("edit");
  edit(cp, file, "agent version");
  writeFileSync(file, "the user's own later edit");
  assert.equal(cp.latest()?.changes[0].conflict, true);
  // The store reports it; the command asks before going ahead, and undoing then does replace it.
  cp.undoLatest();
  assert.equal(readFileSync(file, "utf8"), "original");
});

test("a file that is already gone is a conflict, and undoing a created file that vanished is harmless", (t) => {
  const dir = workdir(t);
  const file = join(dir, "made.txt");
  const cp = new Checkpoints();
  cp.startTurn("make");
  edit(cp, file, "x");
  rmSync(file);
  assert.equal(cp.latest()?.changes[0].conflict, true);
  assert.deepEqual(cp.undoLatest()?.deleted, [file]);
});

test("a deleted original is recreated, including its folder", (t) => {
  const dir = workdir(t);
  const file = join(dir, "sub", "f.txt");
  mkdirSync(join(dir, "sub"));
  writeFileSync(file, "keep me");
  const cp = new Checkpoints();
  cp.startTurn("delete");
  edit(cp, file, null);
  rmSync(join(dir, "sub"), { recursive: true });
  assert.deepEqual(cp.undoLatest()?.restored, [file]);
  assert.equal(readFileSync(file, "utf8"), "keep me");
});

test("binary content survives exactly", (t) => {
  const dir = workdir(t);
  const file = join(dir, "b.bin");
  const original = Buffer.from([0, 255, 1, 254, 128, 10, 13]);
  writeFileSync(file, original);
  const cp = new Checkpoints();
  cp.startTurn("binary");
  edit(cp, file, "text now");
  cp.undoLatest();
  assert.deepEqual(readFileSync(file), original);
});

test("a file too large to keep is reported as such and left alone", (t) => {
  const dir = workdir(t);
  const file = join(dir, "huge.bin");
  writeFileSync(file, Buffer.alloc(5_000_001, 1));
  const cp = new Checkpoints();
  cp.startTurn("huge");
  edit(cp, file, "small now");
  assert.deepEqual(cp.latest()?.changes.map((c) => c.unrestorable), [true]);
  assert.deepEqual(cp.undoLatest(), { restored: [], deleted: [], failed: [], skipped: [file] });
  assert.equal(readFileSync(file, "utf8"), "small now");
});

test("only the most recent prompts are kept", (t) => {
  const dir = workdir(t);
  const file = join(dir, "f.txt");
  writeFileSync(file, "0");
  const cp = new Checkpoints();
  for (let i = 1; i <= MAX_TURNS + 5; i++) {
    cp.startTurn(`prompt ${i}`);
    edit(cp, file, String(i));
  }
  const history = cp.history();
  assert.equal(history.length, MAX_TURNS);
  assert.equal(history.at(-1)?.label, "prompt 6");
});

test("a failure to restore one file is reported and the rest still happen", (t) => {
  const dir = workdir(t);
  const good = join(dir, "good.txt");
  const blocked = join(dir, "blocked.txt");
  writeFileSync(good, "good original");
  writeFileSync(blocked, "blocked original");
  const cp = new Checkpoints();
  cp.startTurn("two files");
  edit(cp, blocked, "x");
  edit(cp, good, "y");
  // A folder where the file was makes the write fail.
  rmSync(blocked);
  mkdirSync(blocked);
  const result = cp.undoLatest();
  assert.deepEqual(result?.restored, [good]);
  assert.equal(result?.failed.length, 1);
  assert.equal(result?.failed[0].path, blocked);
  assert.equal(readFileSync(good, "utf8"), "good original");
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness(t: { after(fn: () => void): void }, options: { confirm?: boolean } = {}) {
  const dir = workdir(t);
  const handlers: Record<string, Handler> = {};
  let command: (args: string, ctx: unknown) => Promise<void> = async () => {};
  const notes: { message: string; level?: string }[] = [];
  const questions: { title: string; message: string }[] = [];
  const sent: { content: string; display: boolean }[] = [];
  const ctx = {
    cwd: dir,
    ui: {
      notify: (message: string, level?: string) => notes.push({ message, level }),
      confirm: async (title: string, message: string) => {
        questions.push({ title, message });
        return options.confirm ?? true;
      },
    },
  };
  undo({
    on: (name: string, fn: Handler) => {
      handlers[name] = fn;
    },
    registerCommand: (_name: string, def: { handler: typeof command }) => {
      command = def.handler;
    },
    sendMessage: (message: { content: string; display: boolean }) => sent.push(message),
  } as unknown as ExtensionAPI);
  handlers.session_start({}, ctx);
  return {
    dir,
    notes,
    questions,
    sent,
    run: (args: string) => command(args, ctx),
    /** One prompt in which the agent writes `content` to `name` through the real tool events. */
    prompt: async (text: string, name: string, content: string) => {
      await handlers.input({ text }, ctx);
      handlers.agent_start({}, ctx);
      const input = { path: name };
      handlers.tool_call({ toolName: "write", input }, ctx);
      writeFileSync(join(dir, name), content);
      handlers.tool_result({ toolName: "write", input }, ctx);
      handlers.agent_end({}, ctx);
    },
    read: (name: string) => readFileSync(join(dir, name), "utf8"),
  };
}

test("/undo shows what it will do, asks, restores, and tells the model", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.dir, "a.txt"), "before");
  await h.prompt("rewrite   a.txt\nplease", "a.txt", "after");
  assert.match(h.notes[0].message, /1 file changed\. \/undo puts it back\./);

  await h.run("");
  assert.equal(h.questions[0].title, 'Undo "rewrite a.txt please"?');
  assert.match(h.questions[0].message, /modified {2}a\.txt/);
  assert.match(h.questions[0].message, /shell commands and subagents aren't included/);
  assert.equal(h.read("a.txt"), "before");
  assert.match(h.notes.at(-1)?.message ?? "", /Undone: restored 1\./);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].display, false);
  assert.match(h.sent[0].content, /undid your last file changes[\s\S]*a\.txt[\s\S]*Read them again/);

  await h.run("");
  assert.match(h.notes.at(-1)?.message ?? "", /Nothing to undo/);
});

test("declining the question leaves everything as it is", async (t) => {
  const h = harness(t, { confirm: false });
  writeFileSync(join(h.dir, "a.txt"), "before");
  await h.prompt("edit", "a.txt", "after");
  await h.run("");
  assert.equal(h.read("a.txt"), "after");
  assert.equal(h.sent.length, 0);
  await h.run("");
  assert.equal(h.questions.length, 2, "still undoable afterwards");
});

test("the question warns about a file changed after the agent left it", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.dir, "a.txt"), "before");
  await h.prompt("edit", "a.txt", "after");
  writeFileSync(join(h.dir, "a.txt"), "someone else");
  await h.run("");
  assert.match(h.questions[0].message, /! a\.txt was changed after the agent wrote it/);
});

test("a created file is listed as one that will be deleted", async (t) => {
  const h = harness(t);
  await h.prompt("make it", "new.txt", "hello");
  await h.run("list");
  assert.match(h.notes.at(-1)?.message ?? "", /Next undo · "make it" · [\s\S]*created {3}new\.txt {2}\(will be deleted\)/);
  await h.run("");
  assert.equal(existsSync(join(h.dir, "new.txt")), false);
});

test("the one-line hint appears once per session, and nothing is said when no file changed", async (t) => {
  const h = harness(t);
  await h.prompt("one", "a.txt", "1");
  await h.prompt("two", "b.txt", "2");
  assert.equal(h.notes.filter((n) => n.message.includes("/undo puts")).length, 1);

  const quiet = harness(t);
  await quiet.run("");
  assert.match(quiet.notes.at(-1)?.message ?? "", /Nothing to undo/);
  await quiet.run("list");
  assert.match(quiet.notes.at(-1)?.message ?? "", /Nothing to undo/);
  await quiet.run("everything");
  assert.match(quiet.notes.at(-1)?.message ?? "", /Usage: \/undo/);
});
