/**
 * The questions panel behind the `ask` tool.
 *
 * One bordered panel with a tab per question, a pick list for each, and an "Other…" row
 * that opens a text box. Keys: up/down move, enter picks, space toggles in a multi-select,
 * left/right or tab switch question, esc dismisses. The state machine and rendering are
 * plain code so they can be tested without a terminal.
 */
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { messages } from "./i18n.ts";

// Only what the person sees in the panel. What the model reads (normalizeQuestions, answersText) stays English.
const say = messages(
  {
    questionTab: "Q{number}",
    otherTyping: "Other: ",
    other: "Other…",
    typingHint: "enter to confirm · esc to go back",
    move: "↑↓ move",
    multiHint: "space toggle · enter confirm",
    singleHint: "enter select",
    switchHint: "tab switch",
    dismissHint: "esc dismiss",
  },
  {
    questionTab: "P{number}",
    otherTyping: "Lainnya: ",
    other: "Lainnya…",
    typingHint: "enter untuk konfirmasi · esc untuk kembali",
    move: "↑↓ pindah",
    multiHint: "space centang · enter konfirmasi",
    singleHint: "enter pilih",
    switchHint: "tab ganti pertanyaan",
    dismissHint: "esc tutup",
  },
);

export type Option = { label: string; description?: string };
export type Question = { question: string; header?: string; options: Option[]; multiSelect?: boolean };
export type Answer = { question: string; header?: string; picked: string[] };
export type AskResult = { answers: Answer[] } | undefined;

type Colors = Pick<Theme, "fg" | "bold">;

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/** Checks what the model sent; returns the questions, or a message it can act on. */
export function normalizeQuestions(raw: unknown): Question[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "Give at least one question.";
  if (raw.length > MAX_QUESTIONS) return `Ask at most ${MAX_QUESTIONS} questions at a time.`;
  const out: Question[] = [];
  for (const [i, item] of raw.entries()) {
    const q = item as Partial<Question> | null;
    const text = typeof q?.question === "string" ? q.question.trim() : "";
    if (!text) return `Question ${i + 1} has no text.`;
    const options = Array.isArray(q?.options)
      ? q.options.filter((o) => typeof o?.label === "string" && o.label.trim()).map((o) => ({ label: o.label.trim(), description: o.description?.trim() || undefined }))
      : [];
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return `Question ${i + 1} needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options.`;
    out.push({ question: text, header: q?.header?.trim() || undefined, options, multiSelect: q?.multiSelect === true });
  }
  return out;
}

/** What the model reads back. */
export function answersText(result: AskResult): string {
  if (!result) return "The user dismissed the question without answering. Do not ask again; continue with a reasonable assumption and say what you assumed.";
  return ["The user answered:", ...result.answers.map((a) => `- ${a.header ?? a.question}: ${a.picked.join(", ")}`)].join("\n");
}

export class AskPanel implements Component, Focusable {
  private questions: Question[];
  private theme: Colors;
  private finish: (result: AskResult) => void;
  private tab = 0;
  private cursor: number[];
  private picked: Set<number>[];
  private other: (string | undefined)[];
  private answered: boolean[];
  private typing = false;
  private input = new Input();
  private _focused = false;
  private done = false;

  constructor(questions: Question[], theme: Colors, finish: (result: AskResult) => void) {
    this.questions = questions;
    this.theme = theme;
    this.finish = finish;
    this.cursor = questions.map(() => 0);
    this.picked = questions.map(() => new Set<number>());
    this.other = questions.map(() => undefined);
    this.answered = questions.map(() => false);
    this.input.onSubmit = (value) => this.commitOther(value);
    this.input.onEscape = () => {
      this.typing = false;
    };
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.typing;
  }

  invalidate(): void {}

  private get q(): Question {
    return this.questions[this.tab];
  }

  private answerFor(i: number): string[] {
    const q = this.questions[i];
    const labels = [...this.picked[i]].sort((a, b) => a - b).map((n) => q.options[n].label);
    const other = this.other[i];
    return other ? [...labels, other] : labels;
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (this.typing) {
      this.input.handleInput(data);
      this.input.focused = this._focused && this.typing;
      return;
    }
    const n = this.q.options.length;
    if (matchesKey(data, "escape")) return this.close(undefined);
    if (matchesKey(data, "up")) this.cursor[this.tab] = (this.cursor[this.tab] + n) % (n + 1);
    else if (matchesKey(data, "down")) this.cursor[this.tab] = (this.cursor[this.tab] + 1) % (n + 1);
    else if (this.questions.length > 1 && (matchesKey(data, "right") || matchesKey(data, "tab"))) this.tab = (this.tab + 1) % this.questions.length;
    else if (this.questions.length > 1 && (matchesKey(data, "left") || matchesKey(data, "shift+tab"))) this.tab = (this.tab + this.questions.length - 1) % this.questions.length;
    else if (data === " ") this.space();
    else if (matchesKey(data, "enter")) this.enter();
  }

  private startTyping(): void {
    this.typing = true;
    this.input.setValue(this.other[this.tab] ?? "");
    this.input.focused = this._focused;
  }

  private space(): void {
    const at = this.cursor[this.tab];
    if (at === this.q.options.length) return this.startTyping();
    if (!this.q.multiSelect) return;
    const set = this.picked[this.tab];
    if (!set.delete(at)) set.add(at);
  }

  private enter(): void {
    const at = this.cursor[this.tab];
    if (at === this.q.options.length) return this.startTyping();
    const set = this.picked[this.tab];
    if (this.q.multiSelect) {
      if (set.size === 0 && !this.other[this.tab]) set.add(at);
    } else {
      set.clear();
      set.add(at);
      this.other[this.tab] = undefined;
    }
    this.answered[this.tab] = true;
    this.advance();
  }

  private commitOther(value: string): void {
    const text = value.trim();
    this.typing = false;
    this.input.focused = false;
    if (!text) return;
    this.other[this.tab] = text;
    if (!this.q.multiSelect) this.picked[this.tab].clear();
    this.answered[this.tab] = true;
    this.advance();
  }

  /** Move to the next question that still needs an answer, or finish. */
  private advance(): void {
    for (let step = 1; step <= this.questions.length; step++) {
      const next = (this.tab + step) % this.questions.length;
      if (!this.answered[next]) {
        this.tab = next;
        return;
      }
    }
    this.close({
      answers: this.questions.map((q, i) => ({ question: q.question, header: q.header, picked: this.answerFor(i) })),
    });
  }

  private close(result: AskResult): void {
    this.done = true;
    this.finish(result);
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(10, width - 4);
    const body: string[] = [];
    if (this.questions.length > 1) {
      const chips = this.questions.map((q, i) => {
        const label = `${this.answered[i] ? "✓" : "·"} ${q.header ?? say("questionTab", { number: i + 1 })}`;
        return i === this.tab ? t.fg("accent", t.bold(`[${label}]`)) : t.fg(this.answered[i] ? "success" : "dim", ` ${label} `);
      });
      body.push(chips.join(" "), "");
    }
    for (const line of wrapTextWithAnsi(t.bold(this.q.question), inner)) body.push(line);
    body.push("");
    const q = this.q;
    const at = this.cursor[this.tab];
    q.options.forEach((option, i) => {
      const here = at === i && !this.typing;
      const mark = q.multiSelect ? (this.picked[this.tab].has(i) ? "[x]" : "[ ]") : `${i + 1}.`;
      const head = `${here ? "›" : " "} ${mark} ${option.label}`;
      body.push(here ? t.fg("accent", t.bold(head)) : this.picked[this.tab].has(i) ? t.fg("success", head) : head);
      if (option.description) for (const line of wrapTextWithAnsi(option.description, inner - 6)) body.push(`      ${t.fg("dim", line)}`);
    });
    const otherHere = at === q.options.length;
    const otherNumber = q.multiSelect ? "[ ]" : `${q.options.length + 1}.`;
    if (this.typing) {
      // The input gets what the label leaves: 14 columns with the English "Other: ".
      const label = say("otherTyping");
      body.push(t.fg("accent", `› ${otherNumber} ${label}`) + (this.input.render(Math.max(5, inner - 7 - visibleWidth(label)))[0] ?? ""));
    } else {
      const saved = this.other[this.tab];
      const head = `${otherHere ? "›" : " "} ${otherNumber} ${say("other")}${saved ? ` ${saved}` : ""}`;
      body.push(otherHere ? t.fg("accent", t.bold(head)) : saved ? t.fg("success", head) : t.fg("muted", head));
    }
    body.push("");
    const hint = this.typing
      ? say("typingHint")
      : [
          say("move"),
          say(q.multiSelect ? "multiHint" : "singleHint"),
          ...(this.questions.length > 1 ? [say("switchHint")] : []),
          say("dismissHint"),
        ].join(" · ");
    for (const line of wrapTextWithAnsi(hint, inner)) body.push(t.fg("dim", line));

    const edge = (text: string) => t.fg("accent", text);
    const row = (content: string) => `${edge("│")} ${truncateToWidth(content, inner, "…")}${" ".repeat(Math.max(0, inner - visibleWidth(truncateToWidth(content, inner, "…"))))} ${edge("│")}`;
    return [edge(`╭${"─".repeat(inner + 2)}╮`), ...body.map(row), edge(`╰${"─".repeat(inner + 2)}╯`)];
  }
}
