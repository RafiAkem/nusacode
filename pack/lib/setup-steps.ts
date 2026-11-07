/**
 * The screens inside the `/setup` wizard: language, API key, default model,
 * import, and the closing summary.
 *
 * Each step takes what it needs as plain functions (check a key, save it, list
 * models, run an import), so none of them touches the network, the disk or pi
 * directly, and the tests can drive them with stand-ins. setup.ts wires them up.
 *
 * Titles, labels and every line are read through `m` when drawn, so moving the
 * cursor on the language step redraws the whole frame in that language.
 */
import { decodeKittyPrintable, Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { messages } from "./i18n.ts";
import { idr, USD_IDR, usd } from "./money.ts";
import type { SetupStep, StepDefinition, StepHost } from "./setup-wizard.ts";

const m = messages(
  {
    move: "↑↓ move",
    select: "enter select",
    continue: "enter continue",
    current: "current",

    "language.label": "Language",
    "language.title": "Choose your language",
    "language.subtitle":
      "The language of NusaCode's screens: setup, the footer, /usage and its messages. The agent still replies in whatever language you write in. /language changes it later.",

    "key.label": "API key",
    "key.title": "Connect to NusaGate",
    "key.subtitle":
      "Every model runs through NusaGate, billed in rupiah from your wallet. Paste your API key; it stays in auth.json on this machine.",
    "key.hint.choose": "↑↓ move · enter select · esc keep",
    "key.hint.input": "enter check and save · esc skip for now",
    "key.hint.inputBack": "enter check and save · esc back",
    "key.hint.checking": "checking…",
    "key.empty": "Paste your key first, or press esc to skip for now.",
    "key.rejected": "NusaGate didn't accept that key. Check it and paste it again.",
    "key.accepted": "✓ Key accepted",
    "key.balance": " · balance {amount}",
    "key.unreachable": "! Couldn't reach NusaGate, so the key was saved without a check.",
    "key.have": "✓ NusaCode already has a NusaGate key.",
    "key.keep": "Keep this key",
    "key.replace": "Use a different key",
    "key.checking": "Checking the key with NusaGate…",
    "key.noKey": "No key yet? Make one at {url}",

    "model.label": "Model",
    "model.title": "Pick your default model",
    "model.subtitle": "New sessions start on this one. /model switches at any time, and the footer shows what each prompt costs.",
    "model.hint": "↑↓ move · type to filter · enter choose · esc keep current",
    "model.hintFilter": "↑↓ move · type to filter · enter choose · esc clear filter",
    "model.hintBusy": "switching…",
    "model.prices": "Prices per million tokens, input / output.",
    "model.dollars": " Dollars at {rate} = $1, for reference.",
    "model.filter": "Filter:",
    "model.matches": "{shown} of {total}",
    "model.noMatch": "No model matches that filter.",
    "model.more": "↓ {count} more",
    "model.switching": "Switching to {name}…",
    "model.failed": "Couldn't switch to {name}.",
    "model.col.model": "Model",
    "model.col.context": "Context",
    "model.col.rupiah": "Rupiah",
    "model.col.dollars": "Dollars",
    "model.vision": "vision",

    "import.label": "Import",
    "import.title": "Bring your setup with you",
    "import.subtitle": "NusaCode found skills and instructions from other coding agents. Pick what to copy over.",
    "import.hint": "↑↓ move · space toggle · enter import · esc skip",
    "import.skill": "{count} skill",
    "import.skills": "{count} skills",
    "import.instructions": "global instructions",
    "import.and": " and ",
    "import.headline": "Imported {what} from {from}",
    "import.done": "✓ {headline}. They load from your next session.",
    "import.nothingNew": "Nothing new: {names} already there.",
    "import.nothing": "Nothing new to import.",
    "import.names": "Skills: {names}",
    "import.more": ", +{count} more",
    "import.becomes": "{file} becomes your global AGENTS.md, unless you already have one.",
    "import.safe": "Copies only. Nothing is overwritten, and API keys and MCP servers stay behind.",

    "ready.label": "Ready",
    "ready.title": "You're all set",
    "ready.subtitle": "Press enter to start your first session.",
    "ready.hint": "enter start",
    "ready.language": "NusaCode is in {language}",
    "ready.connected": "Connected to NusaGate",
    "ready.unchecked": "Key saved, but NusaGate couldn't be reached to check it",
    "ready.existing": "Using your NusaGate key",
    "ready.keyError": "Key not saved: {message}",
    "ready.noKey": "No API key yet. Run /setup again, or set NUSAGATE_API_KEY",
    "ready.defaultModel": "Default model: {name}",
    "ready.model": "Model: {name}",
    "ready.imports": "{headline} (loads next session)",
    "ready.goodToKnow": "Good to know",
    "ready.tip1": "The footer shows what each prompt costs, in rupiah. /usage has the breakdown.",
    "ready.tip2": "/undo puts back the files the agent changed in its last prompt.",
    "ready.tip3": "The agent can make mistakes. Read what it changes before you ship it.",
    "ready.tip4": "/setup runs this again whenever you like.",
  },
  {
    move: "↑↓ pindah",
    select: "enter pilih",
    continue: "enter lanjut",
    current: "saat ini",

    "language.label": "Bahasa",
    "language.title": "Pilih bahasa",
    "language.subtitle":
      "Bahasa untuk layar NusaCode: setup, footer, /usage, dan pesan-pesannya. Agent tetap membalas dalam bahasa yang kamu pakai saat menulis. /language bisa menggantinya nanti.",

    "key.label": "API key",
    "key.title": "Hubungkan ke NusaGate",
    "key.subtitle":
      "Semua model berjalan lewat NusaGate dan ditagih dalam rupiah dari saldo kamu. Tempel API key kamu; key disimpan di auth.json di komputer ini.",
    "key.hint.choose": "↑↓ pindah · enter pilih · esc pakai yang ada",
    "key.hint.input": "enter cek dan simpan · esc lewati dulu",
    "key.hint.inputBack": "enter cek dan simpan · esc kembali",
    "key.hint.checking": "mengecek…",
    "key.empty": "Tempel key kamu dulu, atau tekan esc untuk melewati.",
    "key.rejected": "NusaGate menolak key itu. Cek lagi lalu tempel ulang.",
    "key.accepted": "✓ Key diterima",
    "key.balance": " · saldo {amount}",
    "key.unreachable": "! NusaGate tidak bisa dihubungi, jadi key disimpan tanpa dicek.",
    "key.have": "✓ NusaCode sudah punya key NusaGate.",
    "key.keep": "Pakai key ini",
    "key.replace": "Pakai key lain",
    "key.checking": "Mengecek key ke NusaGate…",
    "key.noKey": "Belum punya key? Buat di {url}",

    "model.label": "Model",
    "model.title": "Pilih model default",
    "model.subtitle": "Sesi baru dimulai dengan model ini. /model bisa menggantinya kapan saja, dan footer menunjukkan biaya tiap prompt.",
    "model.hint": "↑↓ pindah · ketik untuk menyaring · enter pilih · esc pakai yang sekarang",
    "model.hintFilter": "↑↓ pindah · ketik untuk menyaring · enter pilih · esc hapus saringan",
    "model.hintBusy": "mengganti…",
    "model.prices": "Harga per sejuta token, input / output.",
    "model.dollars": " Dolar dengan kurs {rate} = $1, sebagai acuan.",
    "model.filter": "Saring:",
    "model.matches": "{shown} dari {total}",
    "model.noMatch": "Tidak ada model yang cocok.",
    "model.more": "↓ {count} lagi",
    "model.switching": "Mengganti ke {name}…",
    "model.failed": "Gagal mengganti ke {name}.",
    "model.col.model": "Model",
    "model.col.context": "Konteks",
    "model.col.rupiah": "Rupiah",
    "model.col.dollars": "Dolar",
    "model.vision": "vision",

    "import.label": "Impor",
    "import.title": "Bawa setup kamu",
    "import.subtitle": "NusaCode menemukan skill dan instruksi dari coding agent lain. Pilih yang mau disalin.",
    "import.hint": "↑↓ pindah · spasi centang · enter impor · esc lewati",
    "import.skill": "{count} skill",
    "import.skills": "{count} skill",
    "import.instructions": "instruksi global",
    "import.and": " dan ",
    "import.headline": "{what} diimpor dari {from}",
    "import.done": "✓ {headline}. Mulai dipakai di sesi berikutnya.",
    "import.nothingNew": "Tidak ada yang baru: {names} sudah ada.",
    "import.nothing": "Tidak ada yang baru untuk diimpor.",
    "import.names": "Skill: {names}",
    "import.more": ", +{count} lagi",
    "import.becomes": "{file} jadi AGENTS.md global kamu, kecuali kamu sudah punya.",
    "import.safe": "Hanya menyalin. Tidak ada yang ditimpa, dan API key serta server MCP tidak ikut disalin.",

    "ready.label": "Siap",
    "ready.title": "Semua sudah siap",
    "ready.subtitle": "Tekan enter untuk mulai sesi pertama kamu.",
    "ready.hint": "enter mulai",
    "ready.language": "NusaCode memakai {language}",
    "ready.connected": "Terhubung ke NusaGate",
    "ready.unchecked": "Key disimpan, tapi NusaGate tidak bisa dihubungi untuk mengeceknya",
    "ready.existing": "Memakai key NusaGate kamu",
    "ready.keyError": "Key tidak disimpan: {message}",
    "ready.noKey": "Belum ada API key. Jalankan /setup lagi, atau atur NUSAGATE_API_KEY",
    "ready.defaultModel": "Model default: {name}",
    "ready.model": "Model: {name}",
    "ready.imports": "{headline} (dipakai mulai sesi berikutnya)",
    "ready.goodToKnow": "Perlu diketahui",
    "ready.tip1": "Footer menunjukkan biaya tiap prompt dalam rupiah. /usage berisi rinciannya.",
    "ready.tip2": "/undo mengembalikan file yang diubah agent di prompt terakhirnya.",
    "ready.tip3": "Agent bisa salah. Baca perubahannya sebelum kamu rilis.",
    "ready.tip4": "/setup bisa dijalankan lagi kapan saja.",
  },
);

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
  /** Shows the UI in a language while its row is highlighted, before anything is saved. */
  preview(id: string): void;
  /** Saves the choice; resolves with an error message, or null. */
  save(id: string): string | null;
  onChosen(choice: LanguageChoice): void;
}

class LanguageStep implements SetupStep {
  private readonly host: StepHost;
  private readonly options: LanguageStepOptions;
  private cursor: number;
  private error: string | null = null;

  constructor(host: StepHost, options: LanguageStepOptions) {
    this.host = host;
    this.options = options;
    const start = options.languages.findIndex((l) => l.id === (options.current ?? options.fallback));
    this.cursor = Math.max(0, start);
    options.preview(options.languages[this.cursor]!.id);
  }

  get title(): string {
    return m("language.title");
  }

  get subtitle(): string {
    return m("language.subtitle");
  }

  hints(): string {
    return `${m("move")} · ${m("select")}`;
  }

  private moveTo(index: number): void {
    this.cursor = index;
    this.options.preview(this.options.languages[index]!.id);
  }

  handleInput(data: string): void {
    const n = this.options.languages.length;
    if (matchesKey(data, "up")) this.moveTo((this.cursor + n - 1) % n);
    else if (matchesKey(data, "down")) this.moveTo((this.cursor + 1) % n);
    else if (/^[1-9]$/.test(data) && Number(data) <= n) this.moveTo(Number(data) - 1);
    else if (matchesKey(data, "enter")) {
      const choice = this.options.languages[this.cursor]!;
      const problem = this.options.save(choice.id);
      if (problem) {
        this.error = problem;
        return;
      }
      this.options.onChosen(choice);
      this.host.finish("done");
    }
  }

  render(width: number): string[] {
    const t = this.host.theme;
    const labelWidth = Math.max(...this.options.languages.map((l) => visibleWidth(l.label)));
    const lines = this.options.languages.map((language, i) => {
      const active = i === this.cursor;
      const label = fit(language.label, labelWidth);
      const tag = language.id === this.options.current ? t.fg("success", `  ${m("current")}`) : "";
      const row = `${pointer(active, this.host)}${active ? t.bold(t.fg("accent", label)) : label}   ${t.fg(active ? "muted" : "dim", language.sample)}${tag}`;
      return visibleWidth(row) > width ? truncateToWidth(row, width, "…") : row;
    });
    if (this.error) lines.push("", t.fg("error", `✗ ${this.error}`));
    return lines;
  }
}

export function languageStep(options: LanguageStepOptions): StepDefinition {
  return {
    id: "language",
    get label() {
      return m("language.label");
    },
    create: (host) => new LanguageStep(host, options),
  };
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

  get title(): string {
    return m("key.title");
  }

  get subtitle(): string {
    return m("key.subtitle");
  }

  hints(): string {
    if (this.mode === "choose") return m("key.hint.choose");
    if (this.mode === "input") return m(this.options.existingKey ? "key.hint.inputBack" : "key.hint.input");
    if (this.mode === "accepted") return m("continue");
    return m("key.hint.checking");
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
      this.error = m("key.empty");
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
      this.error = m("key.rejected");
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
      const balance = check.balanceIdr === undefined ? "" : m("key.balance", { amount: idr(check.balanceIdr) });
      this.notice = { tone: "success", text: `${m("key.accepted")}${balance}` };
      this.holdMs = ACCEPTED_HOLD_MS;
    } else {
      this.notice = { tone: "warning", text: m("key.unreachable") };
      this.holdMs = WARNING_HOLD_MS;
    }
    this.mode = "accepted";
    this.acceptedAt = this.host.now();
    this.host.requestRender();
  }

  render(width: number): string[] {
    const t = this.host.theme;
    if (this.mode === "choose") {
      const options = [`${m("key.keep")}  ${t.fg("dim", maskKey(this.options.existingKey ?? ""))}`, m("key.replace")];
      return [
        t.fg("success", m("key.have")),
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
    if (this.mode === "checking") lines.push(t.fg("accent", `${spinner(this.host)} ${m("key.checking")}`));
    else if (this.notice) lines.push(t.fg(this.notice.tone, this.notice.text));
    else if (this.error) lines.push(t.fg("error", `✗ ${this.error}`));
    else lines.push(t.fg("dim", m("key.noKey", { url: this.options.dashboardUrl })));
    return lines;
  }
}

export function keyStep(options: KeyStepOptions): StepDefinition {
  return {
    id: "key",
    get label() {
      return m("key.label");
    },
    create: (host) => new KeyStep(host, options),
  };
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
  const nameTitle = m("model.col.model");
  const nameWidth = Math.min(28, Math.max(nameTitle.length, ...models.map((model) => visibleWidth(model.name))));
  const priced = (model: ModelChoice): model is ModelChoice & { inputPer1M: number; outputPer1M: number } =>
    model.inputPer1M !== undefined && model.outputPer1M !== undefined;
  const columns = [
    { id: "context", title: m("model.col.context"), value: (x: ModelChoice) => (x.contextWindow ? contextLabel(x.contextWindow) : "") },
    { id: "rupiah", title: m("model.col.rupiah"), value: (x: ModelChoice) => (priced(x) ? idrPair(x.inputPer1M, x.outputPer1M) : "") },
    { id: "dollars", title: m("model.col.dollars"), value: (x: ModelChoice) => (priced(x) ? `${usd(x.inputPer1M)} / ${usd(x.outputPer1M)}` : "") },
  ]
    .map((c) => ({ ...c, width: Math.max(c.title.length, ...models.map((x) => c.value(x).length)) }))
    .filter((c) => models.some((x) => c.value(x) !== ""));
  // Pointer, name, then each column with a gap; the tags need about 16 more.
  const room = (cols: typeof columns): number => 2 + nameWidth + cols.reduce((sum, c) => sum + GAP.length + c.width, 0) + 16;
  let shown = columns;
  for (const id of ["dollars", "context"]) {
    if (room(shown) <= width) break;
    shown = shown.filter((c) => c.id !== id);
  }
  return {
    dollars: shown.some((c) => c.id === "dollars"),
    header: `${nameTitle.padEnd(nameWidth)}${shown.map((c) => `${GAP}${c.title.padEnd(c.width)}`).join("")}`,
    cells: (x: ModelChoice) => ({
      name: fit(x.name, nameWidth),
      rest: shown.map((c) => `${GAP}${c.value(x).padEnd(c.width)}`).join(""),
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

  get title(): string {
    return m("model.title");
  }

  get subtitle(): string {
    return m("model.subtitle");
  }

  private visible(): ModelChoice[] {
    const needle = this.filter.toLowerCase();
    return needle ? this.all.filter((x) => x.name.toLowerCase().includes(needle) || x.id.toLowerCase().includes(needle)) : this.all;
  }

  hints(): string {
    if (this.busy) return m("model.hintBusy");
    return m(this.filter ? "model.hintFilter" : "model.hint");
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
    // Up and down wrap round, like every other list, so one held key reaches every model.
    if (matchesKey(data, "up")) this.cursor = this.cursor > 0 ? this.cursor - 1 : Math.max(0, list.length - 1);
    else if (matchesKey(data, "down")) this.cursor = this.cursor < list.length - 1 ? this.cursor + 1 : 0;
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
      this.error = m("model.failed", { name: choice.name });
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
    const note = `${m("model.prices")}${table.dollars ? m("model.dollars", { rate: idr(USD_IDR) }) : ""}`;
    lines.push(
      this.filter
        ? `${t.fg("muted", m("model.filter"))} ${this.filter}${t.fg("dim", `  ${m("model.matches", { shown: list.length, total: this.all.length })}`)}`
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
    if (list.length === 0) lines.push(t.fg("dim", `  ${m("model.noMatch")}`));
    for (const [offset, model] of list.slice(this.scroll, this.scroll + rows).entries()) {
      const i = this.scroll + offset;
      const active = i === this.cursor;
      const cells = table.cells(model);
      const tags = [
        ...(model.vision ? [t.fg("accent", m("model.vision"))] : []),
        ...(model.id === this.current ? [t.fg("success", m("current"))] : []),
      ].join(" ");
      let row = `${pointer(active, this.host)}${active ? t.bold(t.fg("accent", cells.name)) : cells.name}${t.fg("muted", cells.rest)}${tags ? `  ${tags}` : ""}`;
      if (visibleWidth(row) > width) row = truncateToWidth(row, width, "…");
      lines.push(row);
    }
    const below = list.length - (this.scroll + rows);
    lines.push(below > 0 ? t.fg("dim", `  ${m("model.more", { count: below })}`) : "");
    if (this.busy) lines.push("", t.fg("accent", `${spinner(this.host)} ${m("model.switching", { name: list[this.cursor]?.name ?? "" })}`));
    else if (this.error) lines.push("", t.fg("error", `✗ ${this.error}`));
    return lines;
  }
}

export function modelStep(options: ModelStepOptions & { skip(): boolean }): StepDefinition {
  return {
    id: "model",
    get label() {
      return m("model.label");
    },
    skip: options.skip,
    create: (host) => new ModelStep(host, options),
  };
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

function skillCount(count: number): string {
  return m(count === 1 ? "import.skill" : "import.skills", { count });
}

function describe(choice: ImportChoice): string {
  const parts: string[] = [];
  if (choice.skills.length > 0) parts.push(skillCount(choice.skills.length));
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
    ...(imported.length > 0 ? [skillCount(imported.length)] : []),
    ...(instructions ? [m("import.instructions")] : []),
  ].join(m("import.and"));
  return m("import.headline", { what, from: from.join(", ") });
}

class ImportStep implements SetupStep {
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

  get title(): string {
    return m("import.title");
  }

  get subtitle(): string {
    return m("import.subtitle");
  }

  hints(): string {
    return this.result ? m("continue") : m("import.hint");
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
      ? { tone: "success", text: m("import.done", { headline }) }
      : { tone: "muted", text: skipped.length > 0 ? m("import.nothingNew", { names: skipped.join(", ") }) : m("import.nothing") };
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
      const text = `${m("import.names", { names })}${more > 0 ? m("import.more", { count: more }) : ""}`;
      lines.push(...wrapTextWithAnsi(t.fg("dim", text), width));
    }
    if (focus?.instructions) lines.push(...wrapTextWithAnsi(t.fg("dim", m("import.becomes", { file: focus.instructions })), width));
    lines.push("");
    lines.push(...wrapTextWithAnsi(t.fg("muted", m("import.safe")), width));
    return lines;
  }
}

export function importStep(options: ImportStepOptions): StepDefinition {
  return {
    id: "import",
    get label() {
      return m("import.label");
    },
    create: (host) => new ImportStep(host, options),
  };
}

// ── Ready ───────────────────────────────────────────────────────────────────

export type SummaryLine = { tone: "success" | "warning"; text: string };

/** What setup decided, for the closing screen. */
export interface SetupSummary {
  /** The UI language's name, when it was chosen in this run. */
  language?: string | null;
  key: KeyOutcome | null;
  model: { name: string; chosen: boolean } | null;
  imports: ImportReport[] | null;
}

export function summaryLines(summary: SetupSummary): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (summary.language) lines.push({ tone: "success", text: m("ready.language", { language: summary.language }) });
  const key = summary.key;
  if (key?.kind === "saved" && key.status === "ok") {
    const balance = key.balanceIdr === undefined ? "" : m("key.balance", { amount: idr(key.balanceIdr) });
    lines.push({ tone: "success", text: `${m("ready.connected")}${balance}` });
  } else if (key?.kind === "saved") {
    lines.push({ tone: "warning", text: m("ready.unchecked") });
  } else if (key?.kind === "existing") {
    lines.push({ tone: "success", text: m("ready.existing") });
  } else if (key?.kind === "error") {
    lines.push({ tone: "warning", text: m("ready.keyError", { message: key.message }) });
  } else if (key?.kind === "skipped") {
    lines.push({ tone: "warning", text: m("ready.noKey") });
  }
  if (summary.model) lines.push({ tone: "success", text: m(summary.model.chosen ? "ready.defaultModel" : "ready.model", { name: summary.model.name }) });
  const headline = summary.imports ? importHeadline(summary.imports) : null;
  if (headline) lines.push({ tone: "success", text: m("ready.imports", { headline }) });
  return lines;
}

/** The closing screen's tips, in the current language. */
export function readyTips(): string[] {
  return [m("ready.tip1"), m("ready.tip2"), m("ready.tip3"), m("ready.tip4")];
}

class ReadyStep implements SetupStep {
  private readonly host: StepHost;
  private readonly summary: () => SetupSummary;
  private readonly mountedAt: number;

  constructor(host: StepHost, summary: () => SetupSummary) {
    this.host = host;
    this.summary = summary;
    this.mountedAt = host.now();
  }

  get title(): string {
    return m("ready.title");
  }

  get subtitle(): string {
    return m("ready.subtitle");
  }

  private lines(): string[] {
    const t = this.host.theme;
    const summary = summaryLines(this.summary());
    return [
      ...summary.map((line) => t.fg(line.tone, `${line.tone === "success" ? "✓" : "!"} ${line.text}`)),
      ...(summary.length > 0 ? [""] : []),
      t.bold(m("ready.goodToKnow")),
      ...readyTips().map((tip) => `${t.fg("accent", "  › ")}${tip}`),
    ];
  }

  private shown(): number {
    return Math.floor((this.host.now() - this.mountedAt) / READY_ROW_MS) + 1;
  }

  hints(): string {
    return m("ready.hint");
  }

  animating(): boolean {
    return this.shown() <= this.lines().length;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter") || matchesKey(data, "escape")) this.host.finish("done");
  }

  render(width: number): string[] {
    return this.lines()
      .slice(0, this.shown())
      .flatMap((line) => (visibleWidth(line) > width ? wrapTextWithAnsi(line, width) : [line]));
  }
}

export function readyStep(summary: () => SetupSummary): StepDefinition {
  return {
    id: "ready",
    get label() {
      return m("ready.label");
    },
    create: (host) => new ReadyStep(host, summary),
  };
}
