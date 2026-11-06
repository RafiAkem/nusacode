/**
 * The screens inside the `/setup` wizard: API key, default model, import, and the
 * closing summary.
 *
 * Each step takes what it needs as plain functions (check a key, save it, list
 * models, run an import), so none of them touches the network, the disk or pi
 * directly, and the tests can drive them with stand-ins. setup.ts wires them up.
 */
import { decodeKittyPrintable, Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { idr, USD_IDR, usd } from "./money.ts";
import type { SetupStep, StepDefinition, StepHost } from "./setup-wizard.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;
/** How long a success line stays up before the step moves on by itself. */
const ACCEPTED_HOLD_MS = 900;
const WARNING_HOLD_MS = 1_800;
const IMPORTED_HOLD_MS = 1_300;
/** The closing summary lands one row at a time, this far apart. */
const READY_ROW_MS = 90;
const MAX_KEY_BOX = 64;
const NAMES_SHOWN = 8;

/** `nsk_••••••••a1b2`: enough to recognise a key, not enough to use it. */
export function maskKey(key: string): string {
  const value = key.trim();
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(Math.min(24, value.length - 8))}${value.slice(-4)}`;
}

function spinner(host: StepHost): string {
  return SPINNER[Math.floor(host.now() / SPINNER_MS) % SPINNER.length]!;
}

/** A printable character typed at the keyboard, or null for keys and escape sequences. */
function typed(data: string): string | null {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  if (data.length === 1 && data >= " " && data !== "\x7f") return data;
  return null;
}

function fit(text: string, width: number): string {
  const cut = truncateToWidth(text, width, "…");
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/** A pick list row: `❯ label` when highlighted, two spaces otherwise. */
function pointer(active: boolean, host: StepHost): string {
  return active ? host.theme.fg("accent", "❯ ") : "  ";
}

// ── Language ────────────────────────────────────────────────────────────────

export type LanguageChoice = { id: string; label: string; sample: string };

export interface LanguageStepOptions {
  languages: readonly LanguageChoice[];
  /** The saved language, or null on a first run. */
  current: string | null;
  fallback: string;
  /** Saves the choice; resolves with an error message, or null. */
  save(id: string): string | null;
  onChosen(choice: LanguageChoice): void;
}

class LanguageStep implements SetupStep {
  readonly title = "Choose your language";
  readonly subtitle = "The language the agent replies in. Code and commands stay as they are, and /language changes it later.";
  private readonly host: StepHost;
  private readonly options: LanguageStepOptions;
  private cursor: number;
  private error: string | null = null;

  constructor(host: StepHost, options: LanguageStepOptions) {
    this.host = host;
    this.options = options;
    const start = options.languages.findIndex((l) => l.id === (options.current ?? options.fallback));
    this.cursor = Math.max(0, start);
  }

  hints(): string {
    return "↑↓ move · enter select";
  }

  handleInput(data: string): void {
    const n = this.options.languages.length;
    if (matchesKey(data, "up")) this.cursor = (this.cursor + n - 1) % n;
    else if (matchesKey(data, "down")) this.cursor = (this.cursor + 1) % n;
    else if (matchesKey(data, "enter")) {
      const choice = this.options.languages[this.cursor]!;
      const problem = this.options.save(choice.id);
      if (problem) {
        this.error = problem;
        return;
      }
      this.options.onChosen(choice);
      this.host.finish("done");
    } else if (/^[1-9]$/.test(data) && Number(data) <= n) {
      this.cursor = Number(data) - 1;
    }
  }

  render(width: number): string[] {
    const t = this.host.theme;
    const labelWidth = Math.max(...this.options.languages.map((l) => visibleWidth(l.label)));
    const lines = this.options.languages.map((language, i) => {
      const active = i === this.cursor;
      const label = fit(language.label, labelWidth);
      const tag = language.id === this.options.current ? t.fg("success", "  current") : "";
      const row = `${pointer(active, this.host)}${active ? t.bold(t.fg("accent", label)) : label}   ${t.fg(active ? "muted" : "dim", language.sample)}${tag}`;
      return visibleWidth(row) > width ? truncateToWidth(row, width, "…") : row;
    });
    if (this.error) lines.push("", t.fg("error", `✗ ${this.error}`));
    return lines;
  }
}

export function languageStep(options: LanguageStepOptions): StepDefinition {
  return { id: "language", label: "Language", create: (host) => new LanguageStep(host, options) };
}

// ── API key ─────────────────────────────────────────────────────────────────

export type KeyCheck = { status: "ok" | "rejected" | "unreachable"; balanceIdr?: number };
export type KeyOutcome =
  | { kind: "existing" }
  | { kind: "saved"; status: "ok" | "unreachable"; balanceIdr?: number }
  | { kind: "skipped" }
  | { kind: "error"; message: string };

export interface KeyStepOptions {
  /** The key pi already has, if any. */
  existingKey: string | null;
  dashboardUrl: string;
  verify(key: string): Promise<KeyCheck>;
  /** Stores the key and switches pi over to it; resolves with an error message, or null. */
  save(key: string): Promise<string | null>;
  onOutcome(outcome: KeyOutcome): void;
}

type KeyMode = "choose" | "input" | "checking" | "accepted";

class KeyStep implements SetupStep {
  readonly title = "Connect to NusaGate";
  readonly subtitle =
    "Every model runs through NusaGate, billed in rupiah from your wallet. Paste your API key; it stays in auth.json on this machine.";
  private readonly host: StepHost;
  private readonly options: KeyStepOptions;
  private readonly input = new Input();
  private mode: KeyMode;
  private cursor = 0;
  private error: string | null = null;
  private notice: { tone: "success" | "warning"; text: string } | null = null;
  private acceptedAt = 0;
  private holdMs = ACCEPTED_HOLD_MS;
  private disposed = false;

  constructor(host: StepHost, options: KeyStepOptions) {
    this.host = host;
    this.options = options;
    this.mode = options.existingKey ? "choose" : "input";
    this.input.onSubmit = (value) => void this.submit(value);
    this.input.onEscape = () => this.escape();
  }

  hints(): string {
    if (this.mode === "choose") return "↑↓ move · enter select · esc keep";
    if (this.mode === "input") return this.options.existingKey ? "enter check and save · esc back" : "enter check and save · esc skip for now";
    if (this.mode === "accepted") return "enter continue";
    return "checking…";
  }

  animating(): boolean {
    return this.mode === "checking" || this.mode === "accepted";
  }

  tick(): void {
    if (this.mode === "accepted" && this.host.now() - this.acceptedAt >= this.holdMs) this.host.finish("done");
  }

  dispose(): void {
    this.disposed = true;
  }

  handleInput(data: string): void {
    if (this.mode === "checking") return;
    if (this.mode === "accepted") {
      if (matchesKey(data, "enter")) this.host.finish("done");
      return;
    }
    if (this.mode === "choose") {
      if (matchesKey(data, "up") || matchesKey(data, "down")) this.cursor = 1 - this.cursor;
      else if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
        if (this.cursor === 0 || matchesKey(data, "escape")) {
          this.options.onOutcome({ kind: "existing" });
          this.host.finish("done");
        } else {
          this.mode = "input";
          this.input.setValue("");
        }
      }
      return;
    }
    this.error = null;
    this.input.handleInput(data);
  }

  private escape(): void {
    if (this.options.existingKey) {
      this.mode = "choose";
      this.error = null;
      return;
    }
    this.options.onOutcome({ kind: "skipped" });
    this.host.finish("skipped");
  }

  private async submit(raw: string): Promise<void> {
    const key = raw.trim();
    if (!key) {
      this.error = "Paste your key first, or press esc to skip for now.";
      return;
    }
    this.mode = "checking";
    this.error = null;
    this.host.requestRender();
    const check = await this.options.verify(key);
    if (this.disposed) return;
    if (check.status === "rejected") {
      this.mode = "input";
      this.input.setValue("");
      this.error = "NusaGate didn't accept that key. Check it and paste it again.";
      this.host.requestRender();
      return;
    }
    const problem = await this.options.save(key);
    if (this.disposed) return;
    if (problem) {
      this.mode = "input";
      this.error = problem;
      this.options.onOutcome({ kind: "error", message: problem });
      this.host.requestRender();
      return;
    }
    this.options.onOutcome({ kind: "saved", status: check.status, balanceIdr: check.balanceIdr });
    if (check.status === "ok") {
      const balance = check.balanceIdr === undefined ? "" : ` · balance ${idr(check.balanceIdr)}`;
      this.notice = { tone: "success", text: `✓ Key accepted${balance}` };
      this.holdMs = ACCEPTED_HOLD_MS;
    } else {
      this.notice = { tone: "warning", text: "! Couldn't reach NusaGate, so the key was saved without a check." };
      this.holdMs = WARNING_HOLD_MS;
    }
    this.mode = "accepted";
    this.acceptedAt = this.host.now();
    this.host.requestRender();
  }

  render(width: number): string[] {
    const t = this.host.theme;
    if (this.mode === "choose") {
      const options = [`Keep this key  ${t.fg("dim", maskKey(this.options.existingKey ?? ""))}`, "Use a different key"];
      return [
        t.fg("success", "✓ NusaCode already has a NusaGate key."),
        "",
        ...options.map((label, i) => `${pointer(i === this.cursor, this.host)}${i === this.cursor ? t.bold(label) : label}`),
      ];
    }
    const boxWidth = Math.max(12, Math.min(MAX_KEY_BOX, width));
    const inner = boxWidth - 4;
    const value = this.input.getValue();
    const masked = maskKey(value);
    // The mask caps a key at 32 columns, so the box never has to scroll it.
    let content: string;
    if (this.mode === "checking") content = `${t.fg("accent", spinner(this.host))} ${t.fg("muted", masked)}`;
    else if (this.mode === "accepted") content = t.fg("muted", masked);
    else if (value) content = `${masked}\x1b[7m \x1b[27m`;
    else content = `\x1b[7m \x1b[27m${t.fg("dim", "nsk_…")}`;
    const border = (s: string): string => t.fg(this.mode === "input" ? "accent" : "dim", s);
    const lines = [
      border(`╭${"─".repeat(boxWidth - 2)}╮`),
      `${border("│")} ${fit(content, inner)} ${border("│")}`,
      border(`╰${"─".repeat(boxWidth - 2)}╯`),
    ];
    if (this.mode === "checking") lines.push(t.fg("accent", `${spinner(this.host)} Checking the key with NusaGate…`));
    else if (this.notice) lines.push(t.fg(this.notice.tone, this.notice.text));
    else if (this.error) lines.push(t.fg("error", `✗ ${this.error}`));
    else lines.push(t.fg("dim", `No key yet? Make one at ${this.options.dashboardUrl}`));
    return lines;
  }
}

export function keyStep(options: KeyStepOptions): StepDefinition {
  return { id: "key", label: "API key", create: (host) => new KeyStep(host, options) };
}

// ── Default model ───────────────────────────────────────────────────────────

export type ModelChoice = {
  id: string;
  name: string;
  /** Rupiah per million tokens. */
  inputPer1M?: number;
  outputPer1M?: number;
  contextWindow?: number;
  vision?: boolean;
};

/** A context window the way people say it: `1M`, `272K`, `128K`. */
export function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 100_000) / 10}M`;
  // Windows that are a power of two read in binary thousands: 131072 is "128K".
  return `${tokens % 1024 === 0 ? tokens / 1024 : Math.round(tokens / 1000)}K`;
}

/** `Rp 1.300 / 4.000`: the second amount drops the currency, which the first already gave. */
function idrPair(input: number, output: number): string {
  return `${idr(input)} / ${idr(output).slice(3)}`;
}

/**
 * The model table's columns, sized to the longest value and dropped from the right
 * when the row would not fit: first dollars, then context. The name always stays.
 */
export function modelColumns(models: readonly ModelChoice[], width: number) {
  const GAP = "  ";
  const nameWidth = Math.min(28, Math.max(5, ...models.map((m) => visibleWidth(m.name))));
  const priced = (m: ModelChoice): m is ModelChoice & { inputPer1M: number; outputPer1M: number } =>
    m.inputPer1M !== undefined && m.outputPer1M !== undefined;
  const columns = [
    { title: "Context", value: (m: ModelChoice) => (m.contextWindow ? contextLabel(m.contextWindow) : "") },
    { title: "Rupiah", value: (m: ModelChoice) => (priced(m) ? idrPair(m.inputPer1M, m.outputPer1M) : "") },
    { title: "Dollars", value: (m: ModelChoice) => (priced(m) ? `${usd(m.inputPer1M)} / ${usd(m.outputPer1M)}` : "") },
  ]
    .map((c) => ({ ...c, width: Math.max(c.title.length, ...models.map((m) => c.value(m).length)) }))
    .filter((c) => models.some((m) => c.value(m) !== ""));
  // Pointer, name, then each column with a gap; the tags need about 16 more.
  const room = (cols: typeof columns): number => 2 + nameWidth + cols.reduce((sum, c) => sum + GAP.length + c.width, 0) + 16;
  const dropOrder = ["Dollars", "Context"];
  let shown = columns;
  for (const title of dropOrder) {
    if (room(shown) <= width) break;
    shown = shown.filter((c) => c.title !== title);
  }
  return {
    dollars: shown.some((c) => c.title === "Dollars"),
    header: `${"Model".padEnd(nameWidth)}${shown.map((c) => `${GAP}${c.title.padEnd(c.width)}`).join("")}`,
    cells: (m: ModelChoice) => ({
      name: fit(m.name, nameWidth),
      rest: shown.map((c) => `${GAP}${c.value(m).padEnd(c.width)}`).join(""),
    }),
  };
}

export interface ModelStepOptions {
  /** Read when the step is reached, after any new key has loaded the gateway's models. */
  models(): ModelChoice[];
  currentId(): string | null;
  select(id: string): Promise<boolean>;
  onChosen(choice: ModelChoice | null): void;
}

class ModelStep implements SetupStep {
  readonly title = "Pick your default model";
  readonly subtitle = "New sessions start on this one. /model switches at any time, and the footer shows what each prompt costs.";
  private readonly host: StepHost;
  private readonly options: ModelStepOptions;
  private readonly all: ModelChoice[];
  private readonly current: string | null;
  private filter = "";
  private cursor = 0;
  private scroll = 0;
  private busy = false;
  private error: string | null = null;
  private disposed = false;

  constructor(host: StepHost, options: ModelStepOptions) {
    this.host = host;
    this.options = options;
    this.all = options.models();
    this.current = options.currentId();
    this.cursor = Math.max(0, this.all.findIndex((model) => model.id === this.current));
  }

  private visible(): ModelChoice[] {
    const needle = this.filter.toLowerCase();
    return needle ? this.all.filter((m) => m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle)) : this.all;
  }

  hints(): string {
    return this.busy ? "switching…" : `↑↓ move · type to filter · enter choose · esc ${this.filter ? "clear filter" : "keep current"}`;
  }

  animating(): boolean {
    return this.busy;
  }

  dispose(): void {
    this.disposed = true;
  }

  handleInput(data: string): void {
    if (this.busy) return;
    const list = this.visible();
    const page = 8;
    if (matchesKey(data, "up")) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, "down")) this.cursor = Math.min(list.length - 1, this.cursor + 1);
    else if (matchesKey(data, "pageUp")) this.cursor = Math.max(0, this.cursor - page);
    else if (matchesKey(data, "pageDown")) this.cursor = Math.min(list.length - 1, this.cursor + page);
    else if (matchesKey(data, "escape")) {
      if (this.filter) {
        this.filter = "";
        this.cursor = Math.max(0, this.all.findIndex((model) => model.id === this.current));
      } else {
        this.options.onChosen(null);
        this.host.finish("skipped");
      }
    } else if (matchesKey(data, "enter")) {
      const choice = list[this.cursor];
      if (choice) void this.choose(choice);
    } else if (matchesKey(data, "backspace")) {
      this.filter = this.filter.slice(0, -1);
      this.cursor = 0;
    } else {
      const char = typed(data);
      if (char !== null && char !== " ") {
        this.filter += char;
        this.cursor = 0;
      }
    }
    this.error = null;
  }

  private async choose(choice: ModelChoice): Promise<void> {
    this.busy = true;
    this.host.requestRender();
    const ok = choice.id === this.current ? true : await this.options.select(choice.id).catch(() => false);
    if (this.disposed) return;
    this.busy = false;
    if (!ok) {
      this.error = `Couldn't switch to ${choice.name}.`;
      this.host.requestRender();
      return;
    }
    this.options.onChosen(choice);
    this.host.finish("done");
  }

  render(width: number, maxLines: number): string[] {
    const t = this.host.theme;
    const list = this.visible();
    const lines: string[] = [];
    const table = modelColumns(list, width);
    const note = `Prices per million tokens, input / output.${table.dollars ? ` Dollars at ${idr(USD_IDR)} = $1, for reference.` : ""}`;
    lines.push(
      this.filter
        ? `${t.fg("muted", "Filter:")} ${this.filter}${t.fg("dim", `  ${list.length} of ${this.all.length}`)}`
        : t.fg("muted", note),
    );
    lines.push("");
    const status = this.busy || this.error ? 2 : 0;
    // Column titles take a row, and the "more" line another.
    const rows = Math.max(3, maxLines - lines.length - 2 - status);
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + rows) this.scroll = this.cursor - rows + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, list.length - rows)));

    lines.push(t.fg("dim", `  ${table.header}`));
    if (list.length === 0) lines.push(t.fg("dim", "  No model matches that filter."));
    for (const [offset, model] of list.slice(this.scroll, this.scroll + rows).entries()) {
      const i = this.scroll + offset;
      const active = i === this.cursor;
      const cells = table.cells(model);
      const tags = [
        ...(model.vision ? [t.fg("accent", "vision")] : []),
        ...(model.id === this.current ? [t.fg("success", "current")] : []),
      ].join(" ");
      let row = `${pointer(active, this.host)}${active ? t.bold(t.fg("accent", cells.name)) : cells.name}${t.fg("muted", cells.rest)}${tags ? `  ${tags}` : ""}`;
      if (visibleWidth(row) > width) row = truncateToWidth(row, width, "…");
      lines.push(row);
    }
    const below = list.length - (this.scroll + rows);
    lines.push(below > 0 ? t.fg("dim", `  ↓ ${below} more`) : "");
    if (this.busy) lines.push("", t.fg("accent", `${spinner(this.host)} Switching to ${list[this.cursor]?.name ?? "the model"}…`));
    else if (this.error) lines.push("", t.fg("error", `✗ ${this.error}`));
    return lines;
  }
}

export function modelStep(options: ModelStepOptions & { skip(): boolean }): StepDefinition {
  return { id: "model", label: "Model", skip: options.skip, create: (host) => new ModelStep(host, options) };
}

// ── Import ──────────────────────────────────────────────────────────────────

export type ImportChoice = { label: string; skills: string[]; instructions: string | null };
export type ImportReport = { label: string; imported: string[]; skipped: string[]; instructions: boolean };

export interface ImportStepOptions {
  sources: ImportChoice[];
  /** Imports the chosen sources, in order. */
  run(labels: string[]): ImportReport[];
  onImported(reports: ImportReport[]): void;
}

function describe(choice: ImportChoice): string {
  const parts: string[] = [];
  if (choice.skills.length > 0) parts.push(`${choice.skills.length} skill${choice.skills.length === 1 ? "" : "s"}`);
  if (choice.instructions) parts.push(choice.instructions);
  return parts.join(" · ");
}

/** One line saying what an import did, for the step and for the summary. */
export function importHeadline(reports: ImportReport[]): string | null {
  const imported = reports.flatMap((r) => r.imported);
  const instructions = reports.some((r) => r.instructions);
  const from = reports.filter((r) => r.imported.length > 0 || r.instructions).map((r) => r.label);
  if (imported.length === 0 && !instructions) return null;
  const what = [
    ...(imported.length > 0 ? [`${imported.length} skill${imported.length === 1 ? "" : "s"}`] : []),
    ...(instructions ? ["global instructions"] : []),
  ].join(" and ");
  return `Imported ${what} from ${from.join(", ")}`;
}

class ImportStep implements SetupStep {
  readonly title = "Bring your setup with you";
  readonly subtitle = "NusaCode found skills and instructions from other coding agents. Pick what to copy over.";
  private readonly host: StepHost;
  private readonly options: ImportStepOptions;
  private readonly picked: boolean[];
  private cursor = 0;
  private result: { text: string; tone: "success" | "muted" } | null = null;
  private doneAt = 0;

  constructor(host: StepHost, options: ImportStepOptions) {
    this.host = host;
    this.options = options;
    this.picked = options.sources.map(() => true);
  }

  hints(): string {
    return this.result ? "enter continue" : "↑↓ move · space toggle · enter import · esc skip";
  }

  animating(): boolean {
    return this.result !== null;
  }

  tick(): void {
    if (this.result && this.host.now() - this.doneAt >= IMPORTED_HOLD_MS) this.host.finish("done");
  }

  handleInput(data: string): void {
    if (this.result) {
      if (matchesKey(data, "enter")) this.host.finish("done");
      return;
    }
    const n = this.options.sources.length;
    if (matchesKey(data, "up")) this.cursor = (this.cursor + n - 1) % n;
    else if (matchesKey(data, "down")) this.cursor = (this.cursor + 1) % n;
    else if (matchesKey(data, "space") || data === " ") this.picked[this.cursor] = !this.picked[this.cursor];
    else if (matchesKey(data, "escape")) {
      this.options.onImported([]);
      this.host.finish("skipped");
    } else if (matchesKey(data, "enter")) this.runImport();
  }

  private runImport(): void {
    const labels = this.options.sources.filter((_, i) => this.picked[i]).map((s) => s.label);
    if (labels.length === 0) {
      this.options.onImported([]);
      this.host.finish("skipped");
      return;
    }
    const reports = this.options.run(labels);
    this.options.onImported(reports);
    const headline = importHeadline(reports);
    const skipped = reports.flatMap((r) => r.skipped);
    this.result = headline
      ? { tone: "success", text: `✓ ${headline}. They load from your next session.` }
      : { tone: "muted", text: skipped.length > 0 ? `Nothing new: ${skipped.join(", ")} already there.` : "Nothing new to import." };
    this.doneAt = this.host.now();
    this.host.requestRender();
  }

  render(width: number): string[] {
    const t = this.host.theme;
    const labelWidth = Math.max(...this.options.sources.map((s) => s.label.length));
    const lines = this.options.sources.map((source, i) => {
      const active = i === this.cursor && !this.result;
      const box = this.picked[i] ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
      const label = source.label.padEnd(labelWidth);
      return `${pointer(active, this.host)}${box} ${active ? t.bold(label) : label}   ${t.fg("muted", describe(source))}`;
    });
    lines.push("");
    if (this.result) {
      lines.push(...wrapTextWithAnsi(t.fg(this.result.tone, this.result.text), width));
      return lines;
    }
    const focus = this.options.sources[this.cursor];
    if (focus && focus.skills.length > 0) {
      const names = focus.skills.slice(0, NAMES_SHOWN).join(", ");
      const more = focus.skills.length - NAMES_SHOWN;
      lines.push(...wrapTextWithAnsi(t.fg("dim", `Skills: ${names}${more > 0 ? `, +${more} more` : ""}`), width));
    }
    if (focus?.instructions) lines.push(t.fg("dim", `${focus.instructions} becomes your global AGENTS.md, unless you already have one.`));
    lines.push("");
    lines.push(...wrapTextWithAnsi(t.fg("muted", "Copies only. Nothing is overwritten, and API keys and MCP servers stay behind."), width));
    return lines;
  }
}

export function importStep(options: ImportStepOptions): StepDefinition {
  return { id: "import", label: "Import", create: (host) => new ImportStep(host, options) };
}

// ── Ready ───────────────────────────────────────────────────────────────────

export type SummaryLine = { tone: "success" | "warning"; text: string };

/** What setup decided, for the closing screen. */
export interface SetupSummary {
  language?: string | null;
  key: KeyOutcome | null;
  model: { name: string; chosen: boolean } | null;
  imports: ImportReport[] | null;
}

export function summaryLines(summary: SetupSummary): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (summary.language) lines.push({ tone: "success", text: `Replies in ${summary.language}` });
  const key = summary.key;
  if (key?.kind === "saved" && key.status === "ok") {
    lines.push({ tone: "success", text: `Connected to NusaGate${key.balanceIdr === undefined ? "" : ` · balance ${idr(key.balanceIdr)}`}` });
  } else if (key?.kind === "saved") {
    lines.push({ tone: "warning", text: "Key saved, but NusaGate couldn't be reached to check it" });
  } else if (key?.kind === "existing") {
    lines.push({ tone: "success", text: "Using your NusaGate key" });
  } else if (key?.kind === "error") {
    lines.push({ tone: "warning", text: `Key not saved: ${key.message}` });
  } else if (key?.kind === "skipped") {
    lines.push({ tone: "warning", text: "No API key yet. Run /setup again, or set NUSAGATE_API_KEY" });
  }
  if (summary.model) lines.push({ tone: "success", text: `${summary.model.chosen ? "Default model" : "Model"}: ${summary.model.name}` });
  const headline = summary.imports ? importHeadline(summary.imports) : null;
  if (headline) lines.push({ tone: "success", text: `${headline} (loads next session)` });
  return lines;
}

export const READY_TIPS = [
  "The footer shows what each prompt costs, in rupiah. /usage has the breakdown.",
  "/undo puts back the files the agent changed in its last prompt.",
  "The agent can make mistakes. Read what it changes before you ship it.",
  "/setup runs this again whenever you like.",
];

class ReadyStep implements SetupStep {
  readonly title = "You're all set";
  readonly subtitle = "Press enter to start your first session.";
  private readonly host: StepHost;
  private readonly summary: SummaryLine[];
  private readonly mountedAt: number;

  constructor(host: StepHost, summary: () => SetupSummary) {
    this.host = host;
    this.summary = summaryLines(summary());
    this.mountedAt = host.now();
  }

  private rows(): number {
    return this.summary.length + (this.summary.length > 0 ? 1 : 0) + 1 + READY_TIPS.length;
  }

  private shown(): number {
    return Math.floor((this.host.now() - this.mountedAt) / READY_ROW_MS) + 1;
  }

  hints(): string {
    return "enter start";
  }

  animating(): boolean {
    return this.shown() <= this.rows();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter") || matchesKey(data, "escape")) this.host.finish("done");
  }

  render(width: number): string[] {
    const t = this.host.theme;
    const all: string[] = [
      ...this.summary.map((line) => t.fg(line.tone, `${line.tone === "success" ? "✓" : "!"} ${line.text}`)),
      ...(this.summary.length > 0 ? [""] : []),
      t.bold("Good to know"),
      ...READY_TIPS.map((tip) => `${t.fg("accent", "  › ")}${tip}`),
    ];
    return all.slice(0, this.shown()).flatMap((line) => (visibleWidth(line) > width ? wrapTextWithAnsi(line, width) : [line]));
  }
}

export function readyStep(summary: () => SetupSummary): StepDefinition {
  return { id: "ready", label: "Ready", create: (host) => new ReadyStep(host, summary) };
}
