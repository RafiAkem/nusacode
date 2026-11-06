import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isReadOnlyCommand, judge, modeNotice, parseMode, statusText, summarize } from "../lib/plan-mode.ts";
import plan from "../extensions/plan.ts";

test("commands that only look are allowed", () => {
  for (const command of [
    "ls",
    "ls -la src",
    "pwd",
    "cat package.json",
    "head -n 20 README.md | grep nusa",
    "grep -rn 'TODO' src | wc -l",
    "rg 'foo bar' --glob '*.ts'",
    "find . -name '*.ts' -not -path './node_modules/*'",
    "git status",
    "git log --oneline -5",
    "git --no-pager diff HEAD~1",
    "git branch -a",
    "git branch --show-current",
    "git stash list",
    "git tag -l",
    "git remote -v",
    "cat a.txt && cat b.txt",
    "ls missing 2>/dev/null",
    "ls missing 2>&1 | head",
    "ls; pwd",
    "/usr/bin/ls",
    "Get-ChildItem -Recurse src | Select-String 'TODO'",
    "Get-Content README.md | Select-Object -First 5",
    "Test-Path package.json",
    "echo 'a > b'",
    'grep "a;b" file',
    "sort names.txt",
  ]) {
    assert.equal(isReadOnlyCommand(command), true, command);
  }
});

test("commands that could change anything are not", () => {
  for (const command of [
    "",
    "   ",
    "rm -rf build",
    "mv a b",
    "cp a b",
    "touch x",
    "mkdir out",
    "npm install",
    "npm test",
    "node script.js",
    "python -c 'open(\"x\",\"w\")'",
    "echo hi > file.txt",
    "echo hi >> file.txt",
    "cat a > b",
    "ls > out.txt",
    "ls 2> errors.txt",
    "ls &> all.txt",
    "cat a | tee b",
    "ls && rm x",
    "ls; rm x",
    "ls || rm x",
    "ls | xargs rm",
    "ls & rm x",
    "ls\nrm x",
    "echo $(rm x)",
    "echo `rm x`",
    "cat <(rm x)",
    "ls ${HOME}",
    "FOO=1 ls",
    "find . -delete",
    "find . -name x -exec rm {} ;",
    "find . -fprint out.txt",
    "sort -o out.txt in.txt",
    "sort --output=out.txt in.txt",
    "rg --pre ./evil pattern",
    "sed -i s/a/b/ file",
    "awk 'BEGIN{system(\"rm x\")}'",
    "git commit -m x",
    "git push",
    "git checkout main",
    "git reset --hard",
    "git branch newbranch",
    "git branch -D old",
    "git tag v1",
    "git remote add x y",
    "git stash",
    "git stash pop",
    "git diff --output=patch.txt",
    "git grep -Oless pattern",
    "git grep --open-files-in-pager=evil pattern",
    "git -c core.pager=evil log",
    "git",
    "Remove-Item x",
    "Set-Content x 1",
    "Get-Content a | Set-Content b",
    "Get-ChildItem | ForEach-Object { Remove-Item $_ }",
    "Get-ChildItem | Where-Object { $_.Length -gt 1 }",
    "& 'rm' x",
    "Invoke-Expression 'rm x'",
    "curl -o x http://example.com",
    "dd if=a of=b",
  ]) {
    assert.equal(isReadOnlyCommand(command), false, JSON.stringify(command));
  }
});

test("plan mode allows looking and refuses the rest, with a reason the model can act on", () => {
  for (const tool of ["read", "grep", "find", "ls", "ask"]) assert.deepEqual(judge("plan", tool, {}), { kind: "allow" }, tool);
  assert.deepEqual(judge("plan", "bash", { command: "git status" }), { kind: "allow" });
  assert.deepEqual(judge("plan", "powershell", { command: "Get-ChildItem" }), { kind: "allow" });
  for (const [tool, input] of [
    ["write", { path: "a", content: "b" }],
    ["edit", { path: "a", edits: [] }],
    ["bash", { command: "rm a" }],
    ["powershell", { command: "Remove-Item a" }],
    ["some_mcp_tool", {}],
  ] as const) {
    const verdict = judge("plan", tool, input);
    assert.equal(verdict.kind, "block", tool);
    assert.match((verdict as { reason: string }).reason, /Plan mode is on[\s\S]*describe the change[\s\S]*\/plan off/);
  }
});

test("a subagent may run in plan mode only when all its tools are read-only", () => {
  assert.equal(judge("plan", "task", { agent: "explorer", prompt: "x" }).kind, "allow");
  assert.equal(judge("plan", "task", { prompt: "x" }).kind, "allow", "explorer is the default");
  assert.equal(judge("plan", "task", { agent: "reviewer", prompt: "x" }).kind, "allow");
  assert.equal(judge("plan", "task", { agent: "writer", prompt: "x" }).kind, "block");
  assert.equal(judge("plan", "task", { agent: "test-runner", prompt: "x" }).kind, "block");
  assert.equal(judge("plan", "task", { agent: "mine", prompt: "x" }).kind, "block", "an unknown agent could have any tools");
});

test("normal mode allows everything", () => {
  assert.deepEqual(judge("off", "bash", { command: "rm -rf /" }), { kind: "allow" });
  assert.deepEqual(judge("off", "write", { path: "a", content: "b" }), { kind: "allow" });
});

test("ask mode lets looking through and asks about each change, showing what it is", () => {
  assert.deepEqual(judge("ask", "read", {}), { kind: "allow" });
  assert.deepEqual(judge("ask", "bash", { command: "ls" }), { kind: "allow" });
  assert.deepEqual(judge("ask", "bash", { command: " npm test " }), { kind: "ask", summary: "Run: npm test" });
  assert.deepEqual(judge("ask", "write", { path: "src/a.ts", content: "one\ntwo\nthree" }), {
    kind: "ask",
    summary: "Write src/a.ts (3 lines)",
  });
  assert.deepEqual(judge("ask", "edit", { path: "src/a.ts", edits: [{}, {}] }), { kind: "ask", summary: "Edit src/a.ts (2 changes)" });
  assert.equal(summarize("edit", { path: "a", edits: [{}] }), "Edit a (1 change)");
  assert.equal(summarize("task", { agent: "writer", prompt: "fix it" }), 'Start the "writer" subagent: fix it');
  assert.deepEqual(judge("ask", "some_mcp_tool", {}), { kind: "ask", summary: "Use the some_mcp_tool tool" });
  assert.equal(judge("ask", "task", { agent: "explorer" }).kind, "allow");
  assert.equal(judge("ask", "task", { agent: "writer" }).kind, "ask");
});

test("the command words", () => {
  assert.equal(parseMode("", "off"), "plan");
  assert.equal(parseMode("", "plan"), "off");
  assert.equal(parseMode("", "ask"), "off");
  assert.equal(parseMode("ON", "off"), "plan");
  assert.equal(parseMode("ask", "off"), "ask");
  assert.equal(parseMode("off", "plan"), "off");
  assert.equal(parseMode(" status ", "plan"), "status");
  assert.equal(parseMode("maybe", "off"), null);
  assert.equal(statusText("off"), undefined);
  assert.match(statusText("plan") ?? "", /plan mode/);
  assert.match(statusText("ask") ?? "", /ask mode/);
  assert.match(modeNotice("plan"), /may not change any file/);
  assert.match(modeNotice("off"), /may change files/);
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness(options: { flag?: boolean; answer?: string; hasUI?: boolean } = {}) {
  const handlers: Record<string, Handler> = {};
  const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const shortcuts: Record<string, (ctx: unknown) => void> = {};
  const flags: string[] = [];
  const sent: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
  const notes: string[] = [];
  const statuses: (string | undefined)[] = [];
  const questions: string[] = [];
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      notify: (message: string) => notes.push(message),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      select: async (title: string, choices: string[]) => {
        questions.push(title);
        return options.answer === undefined ? undefined : choices.find((choice) => choice.startsWith(options.answer as string));
      },
    },
  };
  plan({
    on: (name: string, fn: Handler) => {
      handlers[name] = fn;
    },
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands[name] = def.handler;
    },
    registerShortcut: (key: string, def: { handler: (ctx: unknown) => void }) => {
      shortcuts[key] = def.handler;
    },
    registerFlag: (name: string) => flags.push(name),
    getFlag: () => options.flag,
    sendMessage: (message: never, sendOptions: unknown) => sent.push({ message, options: sendOptions }),
  } as unknown as ExtensionAPI);
  return {
    notes,
    statuses,
    questions,
    sent,
    flags,
    shortcuts,
    ctx,
    start: () => handlers.session_start({}, ctx),
    run: (args: string) => commands.plan(args, ctx),
    call: (toolName: string, input: Record<string, unknown>) =>
      handlers.tool_call({ toolName, input }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>,
  };
}

test("/plan toggles plan mode, shows it in the status bar and tells the model", async () => {
  const h = harness();
  h.start();
  assert.deepEqual(h.flags, ["plan"]);
  assert.equal(await h.call("write", { path: "a", content: "b" }), undefined, "off by default");

  await h.run("");
  assert.equal(h.statuses.at(-1), "plan mode · read-only");
  assert.match(h.notes.at(-1) ?? "", /Plan mode is on/);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "nusacode-mode");
  assert.equal(h.sent[0].message.display, false);
  assert.deepEqual(h.sent[0].options, { deliverAs: "nextTurn" });
  assert.match(h.sent[0].message.content, /may not change any file/);
  assert.equal((await h.call("write", { path: "a", content: "b" }))?.block, true);
  assert.equal(await h.call("read", { path: "a" }), undefined);
  assert.equal(await h.call("bash", { command: "git status" }), undefined);

  await h.run("off");
  assert.equal(h.statuses.at(-1), undefined);
  assert.match(h.sent.at(-1)?.message.content ?? "", /Plan mode is off/);
  assert.equal(await h.call("write", { path: "a", content: "b" }), undefined);
});

test("asking for the mode you are already in changes nothing and says nothing to the model", async () => {
  const h = harness();
  h.start();
  await h.run("off");
  assert.equal(h.sent.length, 0);
  await h.run("status");
  assert.match(h.notes.at(-1) ?? "", /Plan mode is off/);
  await h.run("bogus");
  assert.match(h.notes.at(-1) ?? "", /Usage: \/plan/);
});

test("--plan starts a session in plan mode", async () => {
  const h = harness({ flag: true });
  h.start();
  assert.equal(h.statuses.at(-1), "plan mode · read-only");
  assert.equal((await h.call("edit", { path: "a", edits: [] }))?.block, true);
  assert.equal(h.sent.length, 0, "starting in a mode needs no message: the flag is on for the whole session");
});

test("the keyboard shortcut toggles it", async () => {
  const h = harness();
  h.start();
  h.shortcuts["alt+m"](h.ctx);
  assert.equal((await h.call("bash", { command: "rm x" }))?.block, true);
  h.shortcuts["alt+m"](h.ctx);
  assert.equal(await h.call("bash", { command: "rm x" }), undefined);
});

test("ask mode: allow once, allow and stop asking, or deny with a reason", async () => {
  const allow = harness({ answer: "Allow" });
  allow.start();
  await allow.run("ask");
  assert.equal(allow.statuses.at(-1), "ask mode · changes need approval");
  assert.equal(await allow.call("bash", { command: "npm test" }), undefined);
  assert.match(allow.questions[0], /Allow this\?\nRun: npm test/);
  assert.equal(await allow.call("bash", { command: "ls" }), undefined);
  assert.equal(allow.questions.length, 1, "looking needs no question");
  await allow.call("write", { path: "a", content: "b" });
  assert.equal(allow.questions.length, 2, "still asking");

  const all = harness({ answer: "Allow, and stop" });
  all.start();
  await all.run("ask");
  assert.equal(await all.call("write", { path: "a", content: "b" }), undefined);
  assert.equal(all.statuses.at(-1), undefined);
  await all.call("write", { path: "a", content: "b" });
  assert.equal(all.questions.length, 1, "no more questions");
  assert.match(all.notes.at(-1) ?? "", /Ask mode is off/);

  const deny = harness({ answer: "Deny" });
  deny.start();
  await deny.run("ask");
  const result = await deny.call("write", { path: "src/a.ts", content: "x" });
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /The user declined: Write src\/a\.ts \(1 lines\)\. Ask what they would like instead/);

  const dismissed = harness();
  dismissed.start();
  await dismissed.run("ask");
  assert.equal((await dismissed.call("bash", { command: "npm test" }))?.block, true, "closing the question counts as no");
});

test("ask mode with no screen refuses instead of waiting for an answer", async () => {
  const h = harness({ hasUI: false });
  h.start();
  await h.run("ask");
  const result = await h.call("bash", { command: "npm test" });
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /no screen to ask on/);
  assert.equal(h.questions.length, 0);
});
