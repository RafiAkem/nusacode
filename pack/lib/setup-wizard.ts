/**
 * The `/setup` wizard: one full-screen overlay that plays the splash, dissolves
 * into a run of step screens, and closes when the last one is done.
 *
 * Every step screen shares the same frame: the wordmark and a step counter on top,
 * a step indicator under it, the step's title and subtitle, its body, and the keys
 * at the bottom. Steps only draw their body and handle keys; the wizard owns the
 * frame, the order, the transitions and the timer. Steps are created when they are
 * reached, so a later step can read what an earlier one decided.
 *
 * Rendering is plain code over (size, state, elapsed), so it is testable without a
 * terminal: see pack/test/setup-wizard.test.ts.
 */
import type { Component } from "@earendil-works/pi-tui";
import { foregroundAnsi, matchesKey, parseColor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { messages } from "./i18n.ts";
import { renderSplash, SPLASH_MS, SPLASH_SETTLED_MS } from "./splash.ts";

const m = messages(
  { setup: "setup", step: "step {n} of {total}", exit: "ctrl+c exit setup" },
  { setup: "setup", step: "langkah {n} dari {total}", exit: "ctrl+c keluar" },
);

export const WIZARD_TICK_MS = 40;
/** Splash into the first step, and one step into the next. */
export const SPLASH_DISSOLVE_MS = 420;
export const STEP_DISSOLVE_MS = 200;

/** The step column never gets wider than this, so long lines stay readable. */
const MAX_CONTENT_WIDTH = 84;
const MIN_MARGIN = 2;

const RESET = "\x1b[0m";
const SILVER = parseColor("#dfe8e3");
const GREEN = parseColor("#4ed899");

export type WizardTheme = Pick<Theme, "fg" | "bold" | "getColorMode">;
export type StepResult = "done" | "skipped";
export type WizardOutcome = "completed" | "cancelled";

/** What a step can ask of the wizard. */
export interface StepHost {
  readonly theme: WizardTheme;
  requestRender(): void;
  /** Move on to the next step. */
  finish(result: StepResult): void;
  now(): number;
}

/** A mounted step: it draws the body of the frame and handles keys while it is current. */
export interface SetupStep {
  readonly title: string;
  readonly subtitle?: string;
  /** Body rows, at most `maxLines` of them, each at most `width` columns. */
  render(width: number, maxLines: number): string[];
  handleInput(data: string): void;
  /** The key help shown at the bottom of the frame. */
  hints(): string;
  /** Called every tick while the step is current, for spinners and timed hand-offs. */
  tick?(): void;
  /** True while the body changes on its own, so the wizard keeps repainting. */
  animating?(): boolean;
  dispose?(): void;
}

/** A step as the wizard knows it before it is reached. */
export interface StepDefinition {
  readonly id: string;
  /** Short name in the step indicator. */
  readonly label: string;
  /** Asked when the step is reached; true passes over it and marks it skipped. */
  skip?(): boolean;
  create(host: StepHost): SetupStep;
}

export type StepState = "todo" | "current" | "done" | "skipped";

export interface WizardOptions {
  /** Play the splash first. On by default. */
  readonly splash?: boolean;
  readonly splashMs?: number;
  readonly tickMs?: number;
}

/** The bits of the TUI the wizard needs, so tests can hand it a stand-in. */
export interface WizardTui {
  readonly terminal: { readonly rows: number; readonly columns?: number };
  requestRender(): void;
}

function pad(line: string, width: number): string {
  const fitted = truncateToWidth(line, width, "");
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

/** The column steps draw into: centred, at most MAX_CONTENT_WIDTH wide. */
export function contentColumn(width: number): { left: number; width: number } {
  const inner = Math.max(1, Math.min(MAX_CONTENT_WIDTH, width - MIN_MARGIN * 2));
  return { left: Math.max(0, Math.floor((width - inner) / 2)), width: inner };
}

/**
 * The step indicator: `✓ API key ── ● Model ── ○ Import ── ○ Ready`. When it does not
 * fit, it shrinks to the current step's name.
 */
export function stepIndicator(labels: readonly string[], states: readonly StepState[], theme: WizardTheme, width: number): string {
  const mark = (state: StepState): string => ({ done: "✓", current: "●", skipped: "–", todo: "○" })[state];
  const parts = labels.map((label, i) => {
    const state = states[i] ?? "todo";
    const text = `${mark(state)} ${label}`;
    if (state === "current") return theme.bold(theme.fg("accent", text));
    if (state === "done") return theme.fg("success", text);
    return theme.fg("dim", text);
  });
  const full = parts.join(theme.fg("dim", " ── "));
  if (visibleWidth(full) <= width) return full;
  const current = Math.max(0, states.indexOf("current"));
  return theme.bold(theme.fg("accent", `● ${labels[current] ?? ""}`));
}

export interface FrameInput {
  width: number;
  height: number;
  theme: WizardTheme;
  labels: readonly string[];
  states: readonly StepState[];
  title: string;
  subtitle?: string;
  hints: string;
  /** Draws the body into the room that is left. */
  body: (width: number, maxLines: number) => string[];
}

/** One step screen: exactly `height` rows of exactly `width` columns. */
export function renderFrame(input: FrameInput): string[] {
  const { width: w, height: h, theme } = input;
  const column = contentColumn(w);
  const indent = " ".repeat(column.left);
  const line = (text = ""): string => pad(indent + truncateToWidth(text, column.width, "…"), w);
  const mode = theme.getColorMode();

  const current = Math.max(0, input.states.indexOf("current"));
  const brand = `${theme.bold(`${foregroundAnsi(SILVER, mode)}Nusa${foregroundAnsi(GREEN, mode)}Code${RESET}`)} ${theme.fg("muted", m("setup"))}`;
  const counter = theme.fg("dim", m("step", { n: current + 1, total: input.labels.length }));
  const gap = column.width - visibleWidth(brand) - visibleWidth(counter);
  const top = gap >= 2 ? `${brand}${" ".repeat(gap)}${counter}` : brand;

  const header = [
    line(),
    line(top),
    line(theme.fg("dim", "─".repeat(column.width))),
    line(stepIndicator(input.labels, input.states, theme, column.width)),
    line(),
    line(theme.bold(input.title)),
  ];
  if (input.subtitle) {
    for (const row of wrapTextWithAnsi(theme.fg("muted", input.subtitle), column.width)) header.push(line(row));
  }
  header.push(line());

  const footer = [line(), line(theme.fg("dim", input.hints))];
  const room = Math.max(0, h - header.length - footer.length);
  const body = input.body(column.width, room).slice(0, room).map((row) => line(row));
  const rows = [...header, ...body];
  while (rows.length < h - footer.length) rows.push(line());
  rows.push(...footer);
  // A short terminal keeps the top of the frame and the keys, and loses the middle.
  if (rows.length > h) return h >= 2 ? [...rows.slice(0, h - 1), rows[rows.length - 1]!] : rows.slice(0, h);
  return rows;
}

/** Stable per-row jitter in [0, 1), so the dissolve edge is ragged but repeatable. */
function rowNoise(y: number): number {
  const v = Math.imul(y ^ 0x9e3779b9, 2654435761);
  return ((v ^ (v >>> 15)) >>> 0) / 4294967296;
}

/** Rows flip from one frame to the other, top first, with a ragged edge. */
export function dissolve(from: readonly string[], to: readonly string[], progress: number, height: number): string[] {
  const t = Math.min(1, Math.max(0, progress));
  const eased = t * t * (3 - 2 * t);
  const out: string[] = [];
  for (let y = 0; y < height; y++) {
    const threshold = 0.78 * (y / Math.max(1, height - 1)) + 0.22 * rowNoise(y);
    out.push((eased >= threshold && t > 0 ? to[y] : from[y]) ?? to[y] ?? "");
  }
  return out;
}

type Phase = "splash" | "dissolve" | "step" | "done";

export class SetupWizard implements Component {
  private readonly tui: WizardTui;
  private readonly theme: WizardTheme;
  private readonly definitions: readonly StepDefinition[];
  private readonly finish: (outcome: WizardOutcome) => void;
  private readonly splashMs: number;
  private readonly states: StepState[];
  private phase: Phase;
  private phaseStartedAt = performance.now();
  private index = -1;
  private step: SetupStep | null = null;
  /** The frame to dissolve away from, and how long the dissolve takes. */
  private from: string[] = [];
  private dissolveMs = SPLASH_DISSOLVE_MS;
  private lastFrame: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    tui: WizardTui,
    theme: WizardTheme,
    definitions: readonly StepDefinition[],
    finish: (outcome: WizardOutcome) => void,
    options: WizardOptions = {},
  ) {
    this.tui = tui;
    this.theme = theme;
    this.definitions = definitions;
    this.finish = finish;
    this.splashMs = options.splashMs ?? SPLASH_MS;
    this.states = definitions.map(() => "todo");
    this.phase = options.splash === false ? "step" : "splash";
    if (this.phase === "step") this.advanceTo(0, false);
    this.timer = setInterval(() => this.tick(), options.tickMs ?? WIZARD_TICK_MS);
    this.timer.unref?.();
  }

  /** Index of the current step, -1 during the splash. For tests. */
  get currentStep(): number {
    return this.index;
  }

  get stepStates(): readonly StepState[] {
    return this.states;
  }

  private elapsed(): number {
    return performance.now() - this.phaseStartedAt;
  }

  private tick(): void {
    if (this.phase === "done") return;
    if (this.phase === "splash") {
      const elapsed = this.elapsed();
      if (elapsed >= this.splashMs) this.leaveSplash();
      // The splash is a still frame once settled; repainting it then is wasted work.
      else if (elapsed < SPLASH_SETTLED_MS + WIZARD_TICK_MS) this.tui.requestRender();
      return;
    }
    if (this.phase === "dissolve") {
      if (this.elapsed() >= this.dissolveMs) this.phase = "step";
      this.tui.requestRender();
      return;
    }
    this.step?.tick?.();
    if (this.step?.animating?.()) this.tui.requestRender();
  }

  private leaveSplash(): void {
    if (this.phase !== "splash") return;
    this.from = this.lastFrame;
    this.advanceTo(0, true, SPLASH_DISSOLVE_MS);
  }

  /** Mount the first step at or after `start` that does not skip itself. */
  private advanceTo(start: number, animate: boolean, dissolveMs = STEP_DISSOLVE_MS): void {
    this.step?.dispose?.();
    this.step = null;
    let next = start;
    while (next < this.definitions.length && this.definitions[next]!.skip?.()) {
      this.states[next] = "skipped";
      next++;
    }
    if (next >= this.definitions.length) return this.close("completed");
    this.index = next;
    this.states[next] = "current";
    const definition = this.definitions[next]!;
    let settled = false;
    const host: StepHost = {
      theme: this.theme,
      requestRender: () => this.tui.requestRender(),
      now: () => performance.now(),
      finish: (result) => {
        // A step finishes once; a late timer or a double keypress must not skip ahead.
        if (settled || this.index !== next || this.phase === "done") return;
        settled = true;
        this.states[next] = result === "skipped" ? "skipped" : "done";
        this.from = this.lastFrame;
        this.advanceTo(next + 1, true);
      },
    };
    this.step = definition.create(host);
    if (animate && this.from.length > 0) {
      this.phase = "dissolve";
      this.dissolveMs = dissolveMs;
    } else {
      this.phase = "step";
    }
    this.phaseStartedAt = performance.now();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    // The overlay can be handed a box one cell short of the screen; every cell it
    // leaves uncovered shows the transcript underneath.
    const w = Math.max(1, width, this.tui.terminal.columns ?? 0);
    const h = Math.max(1, this.tui.terminal.rows);
    let frame: string[];
    if (this.phase === "splash") {
      frame = renderSplash(w, h, this.elapsed(), this.theme.getColorMode());
    } else if (this.phase === "done" || !this.step) {
      frame = this.lastFrame.length === h ? this.lastFrame : new Array<string>(h).fill(" ".repeat(w));
    } else {
      const step = this.step;
      const target = renderFrame({
        width: w,
        height: h,
        theme: this.theme,
        labels: this.definitions.map((d) => d.label),
        states: this.states,
        title: step.title,
        subtitle: step.subtitle,
        hints: `${step.hints()} · ${m("exit")}`,
        body: (bodyWidth, maxLines) => step.render(bodyWidth, maxLines),
      });
      // A resize mid-dissolve leaves the old frame the wrong shape; just cut to the new one.
      const shapeMatches = this.from.length === h && visibleWidth(this.from[0] ?? "") === w;
      frame =
        this.phase === "dissolve" && shapeMatches
          ? dissolve(this.from, target, this.elapsed() / this.dissolveMs, h)
          : target;
      if (this.phase === "dissolve") {
        // Keep the target, not the blend, as the frame the next dissolve starts from.
        this.lastFrame = target;
        return frame;
      }
    }
    this.lastFrame = frame;
    return frame;
  }

  handleInput(data: string): void {
    if (this.phase === "done") return;
    if (matchesKey(data, "ctrl+c")) return this.close("cancelled");
    if (this.phase === "splash") {
      if (matchesKey(data, "enter") || matchesKey(data, "escape") || matchesKey(data, "space")) this.leaveSplash();
      return;
    }
    // Keys pressed while the frames are blending belong to the step that is arriving.
    this.step?.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.step?.dispose?.();
    this.step = null;
  }

  private close(outcome: WizardOutcome): void {
    if (this.phase === "done") return;
    this.phase = "done";
    this.dispose();
    this.finish(outcome);
  }
}

/** Runs the wizard in TUI mode. Resolves with how it ended, or null when there is no TUI. */
export async function runSetupWizard(
  ctx: ExtensionContext,
  definitions: readonly StepDefinition[],
  options: WizardOptions = {},
): Promise<WizardOutcome | null> {
  if (!ctx.hasUI || ctx.mode !== "tui" || definitions.length === 0) return null;
  // Overlay, not inline: an inline component is laid out in the transcript, so a
  // full-height frame would overflow the viewport on every tick and scroll.
  return ctx.ui.custom<WizardOutcome>(
    (tui, theme, _keybindings, done) => new SetupWizard(tui, theme, definitions, done, options),
    {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" },
    },
  );
}
