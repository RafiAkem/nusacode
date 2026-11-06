/**
 * Tool calls drawn as bordered cards:
 *
 *   ╭──────────────────────────────────────────╮
 *   │ ✓ read  src/routes/settings.tsx  42 lines · 0.3s ▸ │
 *   ╰──────────────────────────────────────────╯
 *
 * pi stacks a tool's call and result as separate components. With `renderShell: "self"` the
 * call component draws the whole card and the result renderer only hands it the outcome
 * through the row's shared state, so there is one box per call. The body (pi's own result
 * view) shows when expanded, and always on errors so a failure is never hidden.
 */
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { messages } from "../lib/i18n.ts";

const t = messages(
  {
    lineOne: "{count} line",
    lineMany: "{count} lines",
    noOutput: "no output",
    outputOne: "{count} line of output",
    outputMany: "{count} lines of output",
    matchOne: "{count} match",
    matchMany: "{count} matches",
    noMatches: "no matches",
    resultOne: "{count} result",
    resultMany: "{count} results",
    noResults: "no results",
    entryOne: "{count} entry",
    entryMany: "{count} entries",
    noEntries: "no entries",
    moreQuestions: "{first} (+{count} more)",
    dismissed: "dismissed",
    answered: "answered",
    moreLines: "… {count} more lines (expand to see all)",
    added: "Added {added}",
    addedRemoved: "Added {added}, removed {removed}",
  },
  {
    lineOne: "{count} baris",
    lineMany: "{count} baris",
    noOutput: "tidak ada output",
    outputOne: "{count} baris output",
    outputMany: "{count} baris output",
    matchOne: "{count} kecocokan",
    matchMany: "{count} kecocokan",
    noMatches: "tidak ada kecocokan",
    resultOne: "{count} hasil",
    resultMany: "{count} hasil",
    noResults: "tidak ada hasil",
    entryOne: "{count} entri",
    entryMany: "{count} entri",
    noEntries: "tidak ada entri",
    moreQuestions: "{first} (+{count} lagi)",
    dismissed: "ditutup",
    answered: "dijawab",
    moreLines: "… {count} baris lagi (buka untuk lihat semua)",
    added: "Tambah {added}",
    addedRemoved: "Tambah {added}, hapus {removed}",
  },
);

type ResultLike = { content?: { type: string; text?: string }[]; details?: Record<string, unknown> };
type Colors = Pick<Theme, "fg" | "bold" | "bg">;

/** "120ms", "1.4s", "1m 5s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

type CountKeys = { one: Parameters<typeof t>[0]; many: Parameters<typeof t>[0]; none?: Parameters<typeof t>[0] };

/** "1 line", "3 lines", or the `none` wording for zero when there is one. */
function plural(count: number, keys: CountKeys): string {
  if (count === 0 && keys.none) return t(keys.none);
  return t(count === 1 ? keys.one : keys.many, { count });
}

const LINES: CountKeys = { one: "lineOne", many: "lineMany" };

function textOf(result: ResultLike | undefined): string {
  return (result?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

const SHELLS = new Set(["bash", "powershell"]);
const LISTERS: Record<string, CountKeys> = {
  grep: { one: "matchOne", many: "matchMany", none: "noMatches" },
  find: { one: "resultOne", many: "resultMany", none: "noResults" },
  ls: { one: "entryOne", many: "entryMany", none: "noEntries" },
};

/** What came back, or undefined when there is nothing worth saying. */
export function outcome(tool: string, result: ResultLike | undefined): string | undefined {
  const text = textOf(result);
  const lines = text ? text.split("\n").length : 0;
  if (tool === "read") return plural(lines, LINES);
  if (SHELLS.has(tool)) return plural(lines, { one: "outputOne", many: "outputMany", none: "noOutput" });
  const noun = LISTERS[tool];
  if (noun) return plural(lines, noun);
  return undefined;
}

/** "42 lines · 0.3s", or just the time, or nothing. */
export function summaryText(tool: string, result: ResultLike | undefined, durationMs: number | undefined): string {
  const time = durationMs === undefined ? undefined : formatDuration(durationMs);
  return [outcome(tool, result), time].filter(Boolean).join(" · ");
}

/** The one-line subject of a call: the path, command or pattern it works on. */
export function callTarget(args: unknown): string {
  const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const questions = input.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const first = String((questions[0] as { question?: unknown })?.question ?? "").replace(/s+/g, " ").trim();
    return questions.length > 1 ? t("moreQuestions", { first, count: questions.length - 1 }) : first;
  }
  for (const key of ["file_path", "path", "command", "pattern", "prompt", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  }
  return "";
}

type Answered = { question: string; header?: string; picked: string[] };

/** The answers to an ask call as card rows, or undefined when the user dismissed it. */
export function askBody(result: ResultLike, theme: Pick<Theme, "fg">): string[] | undefined {
  const answers = result.details?.answers as Answered[] | undefined;
  if (!Array.isArray(answers) || answers.length === 0) return undefined;
  return answers.flatMap((a) => [theme.fg("muted", a.question), `  ${theme.fg("success", "→")} ${a.picked.join(", ")}`]);
}

export function askSummary(result: ResultLike | undefined): string {
  return result?.details?.dismissed ? t("dismissed") : t("answered");
}

export type CardState = "pending" | "done" | "error";

const DIFF_PREVIEW_LINES = 20;

/**
 * A diff as full-width rows with a red or green background, like `git diff` in a pager.
 * Input is pi's format: a sign, a padded line number, a space, then the text.
 */
const GUTTER = 7; // "  75 + ": line number, space, sign, space

export function diffRows(diff: string, width: number, theme: Colors, highlight: (code: string) => string = (code) => code): string[] {
  const codeWidth = Math.max(1, width - GUTTER);
  const fit = (text: string) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
  return diff.split("\n").flatMap((line) => {
    const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
    if (!match) return [theme.fg("dim", truncateToWidth(line, width, "…", true))];
    const [, sign, num, rest] = match;
    // Long lines wrap under the code instead of being cut off.
    const chunks = wrapTextWithAnsi(highlight(rest.replace(/\t/g, "   ")), codeWidth);
    const color = sign === "+" ? "toolDiffAdded" : "toolDiffRemoved";
    const bg = sign === "+" ? "toolSuccessBg" : "toolErrorBg";
    return (chunks.length ? chunks : [""]).map((chunk, i) => {
      const gutter = i === 0 ? `${theme.fg("dim", num.trim().padStart(4))} ${sign === " " ? " " : theme.fg(color, sign)} ` : " ".repeat(GUTTER);
      const row = fit(truncateToWidth(gutter + chunk, width, "…"));
      return sign === " " ? row : theme.bg(bg, row);
    });
  });
}

/** "Added 8 lines, removed 6 lines" for a diff. */
export function diffSummary(diff: string): string {
  const lines = diff.split("\n");
  const added = lines.filter((line) => line.startsWith("+")).length;
  const removed = lines.filter((line) => line.startsWith("-")).length;
  if (removed === 0) return t("added", { added: plural(added, LINES) });
  return t("addedRemoved", { added: plural(added, LINES), removed: plural(removed, LINES) });
}

/** The diff a write or edit made: an edit's own, or every line of a written file as added. */
export function changeDiff(tool: string, args: unknown, result: ResultLike | undefined): string | undefined {
  if (tool === "edit") return typeof result?.details?.diff === "string" ? result.details.diff : undefined;
  if (tool !== "write") return undefined;
  const content = (args as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") return undefined;
  const lines = content.replace(/\n$/, "").split("\n");
  const digits = String(lines.length).length;
  return lines.map((line, i) => `+${String(i + 1).padStart(digits)} ${line}`).join("\n");
}

export type Card = {
  name: string;
  target: string;
  state: CardState;
  summary: string;
  /** Show the body: expanded by the user, or a change preview. Errors always show it. */
  open: boolean;
  /** pi's own rendering of the result, for the card body. */
  body: string[];
};

// Declared before use by ToolCard.render at runtime.
const ICONS: Record<CardState, string> = { pending: "⠇", done: "✓", error: "✗" };

/** The card as lines, `indent` columns in from the left edge. */
export function cardLines(card: Card, width: number, theme: Colors, indent = 1): string[] {
  const inner = width - indent * 2 - 2; // minus the margins and the two border characters
  if (inner < 8) return [truncateToWidth(`${ICONS[card.state]} ${card.name} ${card.target}`, width, "…")];
  const pad = " ".repeat(indent);
  const borderColor = card.state === "error" ? "error" : card.state === "pending" ? "accent" : "borderMuted";
  const edge = (text: string) => theme.fg(borderColor, text);
  const iconColor = card.state === "error" ? "error" : card.state === "pending" ? "accent" : "success";

  const open = card.open || card.state === "error";
  const arrow = open ? "▾" : "▸";
  const left = `${theme.fg(iconColor, ICONS[card.state])} ${theme.fg("toolTitle", theme.bold(card.name))}${card.target ? ` ${theme.fg("muted", card.target)}` : ""}`;
  const right = theme.fg("dim", card.summary ? `${card.summary} ${arrow}` : arrow);
  const room = inner - 2; // one space of padding either side
  const rightWidth = visibleWidth(right);
  const leftFit = truncateToWidth(left, Math.max(1, room - rightWidth - 1), "…");
  const gap = Math.max(1, room - visibleWidth(leftFit) - rightWidth);
  const row = (content: string) => {
    const fill = Math.max(0, inner - 2 - visibleWidth(content));
    return `${pad}${edge("│")} ${content}${" ".repeat(fill)} ${edge("│")}`;
  };

  const lines = [`${pad}${edge(`╭${"─".repeat(inner)}╮`)}`, row(leftFit + " ".repeat(gap) + right)];
  if (open) {
    for (const line of card.body) lines.push(row(truncateToWidth(line, room, "…")));
  }
  lines.push(`${pad}${edge(`╰${"─".repeat(inner)}╯`)}`);
  return lines;
}

type View = { result: ResultLike; expanded: boolean; isError: boolean; durationMs: number | undefined; body: Component | undefined };

/** Drawn by renderCall; reads the outcome that renderResult left in the row's shared state. */
class ToolCard implements Component {
  private name: string;
  private args: unknown;
  private theme: Theme;
  private state: { view?: View };
  private indent: number;
  constructor(name: string, args: unknown, theme: Theme, state: { view?: View }, indent: number) {
    this.name = name;
    this.args = args;
    this.theme = theme;
    this.state = state;
    this.indent = indent;
  }
  render(width: number): string[] {
    const view = this.state.view;
    const inner = Math.max(1, width - this.indent * 2 - 4);
    let body = view?.body ? view.body.render(inner).map((line) => line.replace(/\s+$/, "")) : [];
    while (body.length > 0 && visibleWidth(body[body.length - 1]) === 0) body.pop();
    if (view && !view.expanded && body.length > ERROR_LINES) body.length = ERROR_LINES; // a collapsed failure shows its head
    const asked = this.name === "ask" && view && !view.isError ? askBody(view.result, this.theme) : undefined;
    if (asked) body = asked;
    const diff = view && !view.isError ? changeDiff(this.name, this.args, view.result) : undefined;
    if (diff !== undefined) {
      // A change is shown as a diff: in full when expanded, a preview otherwise.
      const lang = getLanguageFromPath(callTarget(this.args));
      body = diffRows(diff, inner, this.theme, (code) => highlightCode(code, lang)[0] ?? code);
      if (!view?.expanded && body.length > DIFF_PREVIEW_LINES) {
        const hidden = body.length - DIFF_PREVIEW_LINES;
        body = [...body.slice(0, DIFF_PREVIEW_LINES), this.theme.fg("dim", t("moreLines", { count: hidden }))];
      }
      body.unshift(this.theme.fg("muted", diffSummary(diff)));
    }
    return cardLines(
      {
        name: this.name,
        target: callTarget(this.args),
        state: !view ? "pending" : view.isError ? "error" : "done",
        summary: this.name === "ask" && view && !view.isError ? askSummary(view.result) : view && !view.isError ? summaryText(this.name, view.result, view.durationMs) : view ? summaryText("", undefined, view.durationMs) : "",
        open: (view?.expanded ?? false) || diff !== undefined || asked !== undefined,
        body,
      },
      width,
      this.theme,
      this.indent,
    );
  }
  invalidate(): void {}
}

const ERROR_LINES = 6;
const EMPTY: Component = { render: () => [], invalidate() {} };
const TOOLS = new Set(["ask", "read", "bash", "powershell", "grep", "find", "ls", "edit", "write"]);

export default function toolsView(pi: ExtensionAPI) {
  pi.registerToolRenderer((toolName, next) => {
    const base = next();
    const name = toolName.toLowerCase();
    // ask defines no renderers of its own, so it has no base to wrap.
    if (!TOOLS.has(name) || (!base && name !== "ask")) return base;
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall: (args, theme, context) => {
        const state = context.state as { view?: View };
        return new ToolCard(name, args, theme, state, context.outputPad);
      },
      renderResult: (result, options, theme, context) => {
        const state = context.state as { view?: View };
        // Partial results are streaming output: keep the card pending until the call finishes.
        state.view = options.isPartial
          ? undefined
          : {
              result,
              expanded: options.expanded,
              isError: context.isError,
              durationMs: context.durationMs,
              body: options.expanded || context.isError ? base?.renderResult?.(result, { ...options, expanded: true }, theme, context) : undefined,
            };
        return EMPTY;
      },
    };
  });
}
