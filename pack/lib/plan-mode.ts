/**
 * Deciding what the agent may do while you are only planning, or while you approve each change.
 *
 * - `plan`: read and search only. Anything that could change a file or run a program is refused,
 *   and the refusal tells the model to describe the change instead.
 * - `ask`: reading is free, and every change is shown to you first.
 *
 * The shell is the hard part, because a command can do anything. A command only counts as
 * read-only when every piece of it is on a short list of commands that only look, with no
 * redirects, no substitutions and no options known to write. Anything else is treated as a
 * change. The list is deliberately short: a read-only command wrongly refused costs a retry,
 * and a change wrongly allowed costs a file.
 */
export type Mode = "off" | "plan" | "ask";

/** Tools that only look. `ask` shows the user a question and changes nothing. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "ask"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** Subagents whose tools are all read-only (see config/agents). */
const READ_ONLY_AGENTS = new Set(["explorer", "researcher", "reviewer"]);
const DEFAULT_AGENT = "explorer";

/** Commands that only look, in bash and PowerShell. Compared in lower case, without a directory. */
const LOOK_ONLY = new Set([
  "ls", "dir", "pwd", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "stat", "file",
  "which", "where", "type", "echo", "diff", "cut", "tr", "basename", "dirname", "realpath", "uname",
  "whoami", "du", "df", "true", "false",
  "get-childitem", "gci", "get-content", "gc", "select-string", "sls", "get-location", "gl", "test-path",
  "get-item", "gi", "measure-object", "measure", "sort-object", "select-object", "where-object", "format-list",
  "fl", "format-table", "ft", "get-command", "get-date", "write-output",
]);

/** `find` options that run programs or write files. */
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
/** `sort` writes to the file named by -o. */
const SORT_WRITES = /^(-o|--output)/;

/** git subcommands that only read. `branch`, `tag`, `remote` and `stash` are checked separately. */
const GIT_READS = new Set([
  "status", "log", "diff", "show", "ls-files", "ls-tree", "rev-parse", "rev-list", "blame", "shortlog",
  "describe", "grep", "cat-file", "name-rev", "reflog",
]);
const GIT_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes", "-l"]);

/** Replaces quoted text with an empty pair, so quoted `>` and `;` aren't mistaken for syntax. */
function withoutQuotes(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");
}

/** Redirects that discard output or merge streams; they write nothing a plan has to worry about. */
const HARMLESS_REDIRECTS = /(?:\d?>&\d|\d?>>?\s*\/dev\/null|\d?>>?\s*nul\b|&>\s*\/dev\/null)/gi;

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
  return false;
}

/** True only when the command surely just looks at things. */
export function isReadOnlyCommand(command: string): boolean {
  if (command.trim() === "") return false;
  const plain = withoutQuotes(command);
  // Substitutions and braces can hide a second command or a script block.
  if (/[`{}]|\$\(|<\(|>\(/.test(plain)) return false;
  const rest = plain.replace(HARMLESS_REDIRECTS, " ");
  if (rest.includes(">")) return false;
  return rest.split(/&&|\|\||[;|&\n\r]/).every(segmentIsReadOnly);
}

export type Verdict = { kind: "allow" } | { kind: "block"; reason: string } | { kind: "ask"; summary: string };

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

/** What the user is shown when asked to approve a call. */
export function summarize(tool: string, input: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(tool)) return `Run: ${str(input.command).trim()}`;
  if (tool === "write") return `Write ${str(input.path)} (${lineCount(str(input.content))} lines)`;
  if (tool === "edit") {
    const edits = Array.isArray(input.edits) ? input.edits.length : 1;
    return `Edit ${str(input.path)} (${edits} change${edits === 1 ? "" : "s"})`;
  }
  if (tool === "task") return `Start the "${str(input.agent) || DEFAULT_AGENT}" subagent: ${str(input.prompt).slice(0, 120)}`;
  return `Use the ${tool} tool`;
}

/** Whether a tool call may go ahead in the given mode. */
export function judge(mode: Mode, tool: string, input: Record<string, unknown>): Verdict {
  if (mode === "off" || READ_ONLY_TOOLS.has(tool)) return { kind: "allow" };
  const looksOnly =
    (SHELL_TOOLS.has(tool) && isReadOnlyCommand(str(input.command))) ||
    (tool === "task" && READ_ONLY_AGENTS.has(str(input.agent) || DEFAULT_AGENT));
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
  if (mode === "plan") return "plan mode · read-only";
  if (mode === "ask") return "ask mode · changes need approval";
  return undefined;
}
