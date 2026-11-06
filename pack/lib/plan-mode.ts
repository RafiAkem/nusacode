/**
 * Deciding what the agent may do while you are only planning, or while you approve each change.
 *
 * - `plan`: read and search only. Anything that could change a file or run a program is refused,
 *   and the refusal tells the model to describe the change instead.
 * - `ask`: reading is free, and every change is shown to you first.
 *
 * The shell is the hard part, because a command can do anything. A command only counts as
 * read-only when every piece of it is on a short list of commands that only look, with no
 * redirects, no substitutions, no grouping and no options known to write. Anything else is treated
 * as a change. The list is deliberately short: a read-only command wrongly refused costs a retry,
 * and a change wrongly allowed costs a file.
 */
import { format, messages, type Vars } from "./i18n.ts";

const EN = {
  run: "Run: {command}",
  write: "Write {path} ({count} lines)",
  editOne: "Edit {path} ({count} change)",
  editMany: "Edit {path} ({count} changes)",
  task: 'Start the "{agent}" subagent: {prompt}',
  tool: "Use the {tool} tool",
  statusPlan: "plan mode · read-only",
  statusAsk: "ask mode · changes need approval",
};
const t = messages(EN, {
  run: "Jalankan: {command}",
  write: "Tulis {path} ({count} baris)",
  editOne: "Edit {path} ({count} perubahan)",
  editMany: "Edit {path} ({count} perubahan)",
  task: 'Jalankan subagent "{agent}": {prompt}',
  tool: "Pakai tool {tool}",
  statusPlan: "mode plan · hanya baca",
  statusAsk: "mode ask · perubahan perlu persetujuan",
});
type Say = (key: keyof typeof EN, vars?: Vars) => string;
/** The model reads call summaries inside its tool results, so those stay English. */
const english: Say = (key, vars) => format(EN[key], vars);

export type Mode = "off" | "plan" | "ask";
export type Shell = "bash" | "powershell";

/** Tools that only look. `ask` shows the user a question and changes nothing. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "ask"]);
/** A subagent may run in plan mode when every tool it has is one of these. */
const READ_ONLY_AGENT_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const DEFAULT_AGENT = "explorer";

/** Commands that only look, in bash and PowerShell. Compared in lower case, without a directory. */
const LOOK_ONLY = new Set([
  "ls", "dir", "pwd", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "stat",
  "which", "where", "type", "echo", "diff", "cut", "tr", "basename", "dirname", "realpath", "uname",
  "whoami", "du", "df", "true", "false",
  "get-childitem", "gci", "get-content", "gc", "select-string", "sls", "get-location", "gl", "test-path",
  "get-item", "gi", "measure-object", "measure", "sort-object", "select-object", "where-object", "format-list",
  "fl", "format-table", "ft", "get-command", "get-date", "write-output",
]);

/** `find` options that run programs or write files. */
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
/** `sort -o FILE` writes, also when `o` is one of several short flags, as in `-uo`. */
const SORT_WRITES = /^(?:-[^-]*o|--output)/;

/** git subcommands that only read. `branch`, `tag`, `remote`, `stash` and `reflog` are checked separately. */
const GIT_READS = new Set([
  "status", "log", "diff", "show", "ls-files", "ls-tree", "rev-parse", "rev-list", "blame", "shortlog",
  "describe", "grep", "cat-file", "name-rev",
]);
const GIT_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes", "-l"]);

type Scanned = {
  /** The command with quoted text blanked out, so only what the shell itself reads is left. */
  plain: string;
  /** A substitution inside double quotes (which the shell still runs), or a quote left open. */
  unsafeQuote: boolean;
};

/**
 * Reads the command the way a shell does: single quotes are literal, double quotes still run
 * `$(...)` and backticks, and (in bash) a backslash makes the next character literal. Quoted and
 * escaped characters become `x`, so a quoted `>` or `;` isn't mistaken for syntax, while words keep
 * their shape for the checks that follow.
 */
function scan(command: string, shell: Shell): Scanned {
  let plain = "";
  let unsafeQuote = false;
  let state: "none" | "single" | "double" = "none";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (state === "single") {
      if (c === "'") state = "none";
      plain += c === "'" ? "'" : "x";
    } else if (state === "double") {
      if (c === '"') {
        state = "none";
        plain += '"';
      } else if (c === "`" || (c === "$" && command[i + 1] === "(")) {
        unsafeQuote = true;
        plain += "x";
      } else if (c === "\\" && shell === "bash") {
        plain += "xx";
        i++;
      } else {
        plain += "x";
      }
    } else if (c === "'") {
      state = "single";
      plain += c;
    } else if (c === '"') {
      state = "double";
      plain += c;
    } else if (c === "\\" && shell === "bash") {
      plain += "xx";
      i++;
    } else {
      plain += c;
    }
  }
  // An unclosed quote: the shell would wait for more input or fail. Either way it isn't plainly looking.
  if (state !== "none") unsafeQuote = true;
  return { plain, unsafeQuote };
}

/** Redirects that discard output or merge streams. The lookahead stops `nul.txt` or `/dev/nullx` passing as these. */
const HARMLESS_REDIRECTS = /(?:\d?>&\d|&>\s*\/dev\/null|\d?>>?\s*(?:\/dev\/null|nul))(?=$|[\s;&|])/gi;

function segmentIsReadOnly(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const name = (tokens[0].split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  const rest = tokens.slice(1);
  if (name === "find") return !rest.some((token) => FIND_WRITES.has(token));
  if (name === "sort") return !rest.some((token) => SORT_WRITES.test(token));
  // rg --pre runs a program on every file it searches.
  if (name === "rg") return !rest.some((token) => token.startsWith("--pre"));
  if (name === "git") return gitIsReadOnly(rest);
  return LOOK_ONLY.has(name);
}

function gitIsReadOnly(args: string[]): boolean {
  const flags = args.filter((token) => token !== "--no-pager");
  const [sub, ...rest] = flags;
  if (sub === undefined || sub.startsWith("-")) return false;
  // --output writes the diff to a file, and -O / --open-files-in-pager run a program.
  if (rest.some((token) => token.startsWith("--output") || token.startsWith("--open-files") || token.startsWith("-O"))) return false;
  if (GIT_READS.has(sub)) return true;
  if (sub === "branch") return rest.every((token) => GIT_BRANCH_FLAGS.has(token));
  if (sub === "tag") return rest.every((token) => token === "-l" || token === "--list");
  if (sub === "remote") return rest.every((token) => token === "-v");
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
  // `git reflog` and `git reflog show` read; `expire` and `delete` throw history away for good.
  if (sub === "reflog") return !rest.some((token) => token === "expire" || token === "delete") && (rest[0] === undefined || rest[0] === "show" || rest[0].startsWith("-"));
  return false;
}

/** True only when the command surely just looks at things. */
export function isReadOnlyCommand(command: string, shell: Shell = "bash"): boolean {
  if (command.trim() === "") return false;
  const { plain, unsafeQuote } = scan(command, shell);
  if (unsafeQuote) return false;
  // Each of these can hide a second command: `$(...)`, backticks, a script block, a subshell, or
  // PowerShell running whatever is inside `(...)` and `@(...)`.
  if (/[`{}()]|\$\(/.test(plain)) return false;
  const rest = plain.replace(HARMLESS_REDIRECTS, " ");
  if (rest.includes(">")) return false;
  return rest.split(/&&|\|\||[;|&\n\r]/).every(segmentIsReadOnly);
}

export type Verdict = { kind: "allow" } | { kind: "block"; reason: string } | { kind: "ask"; summary: string };

/** The tools a subagent would run with, from its definition file; undefined when there is no such agent. */
export type AgentTools = (name: string) => string[] | undefined;

const PLAN_REASON =
  "Plan mode is on, so nothing can be changed and no commands that change anything can run. " +
  "Use read, grep, find and ls to look around, then describe the change you would make as a plan. " +
  "The user turns plan mode off with /plan off.";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

function describeCall(say: Say, tool: string, input: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(tool)) return say("run", { command: str(input.command).trim() });
  if (tool === "write") return say("write", { path: str(input.path), count: lineCount(str(input.content)) });
  if (tool === "edit") {
    const edits = Array.isArray(input.edits) ? input.edits.length : 1;
    return say(edits === 1 ? "editOne" : "editMany", { path: str(input.path), count: edits });
  }
  if (tool === "task") return say("task", { agent: str(input.agent) || DEFAULT_AGENT, prompt: str(input.prompt).slice(0, 120) });
  return say("tool", { tool });
}

/** A call in a few words, in English: it goes into what the model reads back. */
export function summarize(tool: string, input: Record<string, unknown>): string {
  return describeCall(english, tool, input);
}

/** The same summary in the UI's language, for the question the user is asked. */
export function summaryShown(tool: string, input: Record<string, unknown>): string {
  return describeCall(t, tool, input);
}

/** A subagent only looks when its definition gives it nothing but read-only tools. An unknown agent could have any. */
function agentOnlyLooks(name: string, agentTools: AgentTools | undefined): boolean {
  const tools = agentTools?.(name);
  return tools !== undefined && tools.every((tool) => READ_ONLY_AGENT_TOOLS.has(tool.trim().toLowerCase()));
}

/**
 * Whether a tool call may go ahead in the given mode. `agentTools` reads a subagent's definition,
 * because those files can be edited, so the name alone says nothing about what the agent may do.
 */
export function judge(mode: Mode, tool: string, input: Record<string, unknown>, agentTools?: AgentTools): Verdict {
  if (mode === "off" || READ_ONLY_TOOLS.has(tool)) return { kind: "allow" };
  const looksOnly =
    (SHELL_TOOLS.has(tool) && isReadOnlyCommand(str(input.command), tool === "powershell" ? "powershell" : "bash")) ||
    (tool === "task" && agentOnlyLooks(str(input.agent) || DEFAULT_AGENT, agentTools));
  if (looksOnly) return { kind: "allow" };
  return mode === "plan" ? { kind: "block", reason: PLAN_REASON } : { kind: "ask", summary: summarize(tool, input) };
}

/** `/plan`, `/plan on`, `/plan ask`, `/plan off`; null for something else. */
export function parseMode(args: string, current: Mode): Mode | "status" | null {
  const word = args.trim().toLowerCase();
  if (word === "") return current === "off" ? "plan" : "off";
  if (word === "on" || word === "plan") return "plan";
  if (word === "ask") return "ask";
  if (word === "off") return "off";
  if (word === "status") return "status";
  return null;
}

/** Said to the model when the mode changes, so it stops trying what is no longer allowed. */
export function modeNotice(mode: Mode): string {
  if (mode === "plan") {
    return "Plan mode is on. You may read and search, but you may not change any file or run commands that change anything. Explore, then describe the change you would make as a plan, and wait for the user to approve it.";
  }
  if (mode === "ask") {
    return "Ask mode is on. Every file change and command now needs the user's approval, and they may decline. If a call is declined, ask what they would like instead.";
  }
  return "Plan mode is off. You may change files and run commands again.";
}

export function statusText(mode: Mode): string | undefined {
  if (mode === "plan") return t("statusPlan");
  if (mode === "ask") return t("statusAsk");
  return undefined;
}
