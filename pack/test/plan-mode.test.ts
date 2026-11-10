import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isReadOnlyCommand, judge, modeNotice, parseMode, statusText, summarize, type AgentTools } from "../lib/plan-mode.ts";
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
    "sort -u names.txt",
    "find . \\( -name '*.ts' -o -name '*.js' \\)",
    "git reflog",
    "git reflog -n 5",
    "git reflog show main",
    "ls >nul",
    'grep "it\'s" notes.txt',
    'echo "hello $HOME"',
  ]) {
    assert.equal(isReadOnlyCommand(command), true, command);
  }
});

test("commands hidden in quotes, brackets or look-alike redirects are caught", () => {
  for (const command of [
    // bash and PowerShell both run substitutions inside double quotes
    'echo "$(rm -rf src)"',
    'echo "`rm -rf src`"',
    // a single quote inside double quotes is literal, so it hides nothing
    "echo \"a'$(rm x)'b\"",
    // PowerShell runs whatever is inside (...) and @(...)
    "Write-Output (Remove-Item -Recurse src)",
    "echo @(Remove-Item src)",
    "gc (Remove-Item x)",
    // a bash subshell
    "( rm x )",
    "ls; (rm x)",
    // looks like a harmless redirect, writes a real file
    "cat a > nul.txt",
    "cat a >/dev/nullx",
    // -o hidden among combined short flags
    "sort -uo out.txt in.txt",
    "sort -ro out.txt in.txt",
    // throws history away
    "git reflog expire --expire=now --all",
    "git reflog delete HEAD@{1}",
    "git reflog --all expire",
    // file -C writes a compiled magic file
    "file -C -m magic",
    // an unclosed quote
    "echo \"unterminated",
  ]) {
    assert.equal(isReadOnlyCommand(command), false, JSON.stringify(command));
  }
  for (const command of ["Write-Output (Remove-Item -Recurse src)", "echo @(Remove-Item src)", 'Write-Output "$(Remove-Item x)"']) {
    assert.equal(isReadOnlyCommand(command, "powershell"), false, `powershell: ${command}`);
  }
  assert.equal(isReadOnlyCommand("Get-ChildItem src | Select-String 'TODO'", "powershell"), true);
  assert.equal(judge("plan", "powershell", { command: "Write-Output (Remove-Item -Recurse src)" }).kind, "block");
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

/** Agent definitions as they ship in config/agents. */
const shipped: AgentTools = (name) =>
  ({
    explorer: ["read", "grep", "find", "ls"],
    researcher: ["read", "grep", "find", "ls"],
    reviewer: ["read", "grep", "find", "ls"],
    "test-runner": ["read", "grep", "bash"],
    writer: ["read", "grep", "edit", "write"],
    silent: [],
  })[name];

test("a subagent may run in plan mode only when its definition gives it read-only tools", () => {
  assert.equal(judge("plan", "task", { agent: "explorer", prompt: "x" }, shipped).kind, "allow");
  assert.equal(judge("plan", "task", { prompt: "x" }, shipped).kind, "allow", "explorer is the default");
  assert.equal(judge("plan", "task", { agent: "reviewer", prompt: "x" }, shipped).kind, "allow");
  assert.equal(judge("plan", "task", { agent: "silent", prompt: "x" }, shipped).kind, "allow", "no tools at all only looks");
  assert.equal(judge("plan", "task", { agent: "writer", prompt: "x" }, shipped).kind, "block");
  assert.equal(judge("plan", "task", { agent: "test-runner", prompt: "x" }, shipped).kind, "block");
  assert.equal(judge("plan", "task", { agent: "mine", prompt: "x" }, shipped).kind, "block", "an unknown agent could have any tools");
  assert.equal(judge("plan", "task", { agent: "explorer", prompt: "x" }).kind, "block", "with no way to read definitions, nothing is trusted");
});

test("an agent is judged by what its file says now, not by its name", () => {
  const edited: AgentTools = (name) => (name === "explorer" ? ["read", "bash", "edit", "write"] : undefined);
  assert.equal(judge("plan", "task", { agent: "explorer", prompt: "x" }, edited).kind, "block");
  assert.equal(judge("ask", "task", { agent: "explorer", prompt: "x" }, edited).kind, "ask");
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
  assert.equal(judge("ask", "task", { agent: "explorer" }, shipped).kind, "allow");
  assert.equal(judge("ask", "task", { agent: "writer" }, shipped).kind, "ask");
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

test("commands that stop every node process are refused in every mode, since NusaCode runs on node", () => {
  for (const command of [
    "taskkill /F /IM node.exe",
    "cd /c/app && (taskkill //F //IM node.exe 2>/dev/null; npm run dev)",
    "taskkill -f -im node.exe /T",
    'taskkill /F /IM "node.exe"',
    "taskkill /im node*",
    "Stop-Process -Name node -Force",
    "Get-Process node | Stop-Process -Force",
    "gps -Name node | kill",
    "pkill node",
    "pkill -9 -f node",
    "killall node",
  ]) {
    for (const mode of ["off", "plan", "ask"] as const) {
      const verdict = judge(mode, "bash", { command });
      assert.equal(verdict.kind, "block", `${mode}: ${command}`);
      assert.match(verdict.kind === "block" ? verdict.reason : "", /NusaCode itself runs on node/);
    }
  }
  for (const command of [
    "taskkill /F /PID 4242",
    "taskkill /F /IM nodemon.exe",
    "Stop-Process -Id 4242",
    'pkill -f "node server.js"',
    "node server.js",
    "npm run dev",
  ]) {
    assert.equal(judge("off", "bash", { command }).kind, "allow", command);
  }
});
