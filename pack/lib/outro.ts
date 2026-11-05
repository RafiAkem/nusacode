/**
 * The scene that closes `/setup`: the mark settles, "Setup saved" lands, a sweep
 * carries the eye out, and then the prompt takes over.
 *
 * The splash on its own just stops — the next screen appears with no acknowledgement
 * that anything finished. oh-my-pi solves this with a dedicated outro scene, and this
 * is the same idea in NusaCode's palette: same glow, same mark, one line of copy, one
 * moving part. Only the sweep row changes between frames, so the scene costs a single
 * dirty row per tick instead of a full repaint.
 *
 * Every frame is a pure function of (size, elapsed) — see pack/test/outro.test.ts.
 */
import type { Color, Component, TUI } from "@earendil-works/pi-tui";
import { foregroundAnsi, mixColors, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { LOGO, GLYPHS as LOGO_GLYPHS, SHADES as LOGO_SHADES } from "../extensions/brand.ts";
import { composeFrame, glowBackground } from "./splash.ts";

export const SETUP_OUTRO_MS = 1_200;
export const OUTRO_TICK_MS = 40;

/** Timing overrides, for tests and for anyone who wants a shorter beat. */
export interface SetupOutroOptions {
  readonly durationMs?: number;
  readonly tickMs?: number;
}

const ACCENT = parseColor("#4ed899");
const GLOW = parseColor("#ecfff6");
const FAINT = parseColor("#7c9a8d");
const TRAIL = parseColor("#1a7a55");

const WORDMARK = "NusaCode";
const TITLE = "Setup saved";
const SUBTITLE = "handing off to the terminal...";

/** ASCII only: a glyph that renders wider than it measures wraps the row. */
const SWEEP_FILLED = "=";
const SWEEP_EMPTY = "-";

/** Bold for the two lines that have to land: SGR 1 on, SGR 22 off. */
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

/**
 * The copy animates in three beats: the wordmark types, the confirmation types under
 * it, then one shine crosses both. The bar fills the whole time. Everything is settled
 * by SHINE_START_MS + SHINE_MS, so the last quarter of the scene repaints one row.
 */
const WORD_START_MS = 60;
const WORD_STEP_MS = 34;
const TITLE_START_MS = 320;
const TITLE_STEP_MS = 26;
const SUBTITLE_AT_MS = 600;
const SHINE_START_MS = 680;
const SHINE_MS = 280;

type Mode = Parameters<typeof foregroundAnsi>[1];

/**
 * One frame of the outro. Pure in (width, height, elapsedMs): the sweep is the only
 * thing that moves, so everything above it is byte-identical between frames.
 */
export function renderOutro(width: number, height: number, elapsedMs: number, mode: Mode = "truecolor"): string[] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const elapsed = Math.max(0, Math.min(SETUP_OUTRO_MS, elapsedMs));
  const progress = elapsed / SETUP_OUTRO_MS;

  const art = LOGO;
  const artWidth = Math.max(...art.map((line) => visibleWidth(line)));
  const artHeight = art.length;
  const sweepWidth = Math.max(6, Math.min(w - 8, 44));
  // mark, gap, wordmark, title, subtitle, gap, sweep
  const blockHeight = artHeight + 6;
  const startY = Math.max(0, Math.floor((h - blockHeight) / 2));
  const left = Math.floor((w - artWidth) / 2);

  const background = glowBackground(
    w,
    h,
    left + artWidth / 2 - 0.5,
    startY + artHeight / 2 - 0.5,
    Math.max(6, w * 0.4),
    Math.max(4, h * 0.48),
    mode,
  );
  const cells: string[][] = Array.from({ length: h }, () => new Array<string>(w).fill(""));
  const put = (x: number, y: number, glyph: string, foreground?: string): void => {
    if (y < 0 || y >= h || x < 0 || x >= w) return;
    cells[y]![x] = `${foreground ?? ""}${glyph}`;
  };
  /**
   * One animated line: it types itself out, the newest glyph burns white, and a shine
   * can be travelling across it. Bold is opened on the first glyph and closed after the
   * last drawn one, so a half-typed row never leaks weight into the next row.
   */
  const writeLine = (
    text: string,
    y: number,
    base: Color,
    bold: boolean,
    shown: number,
    shine: number | null,
  ): void => {
    const start = Math.floor((w - text.length) / 2);
    const drawn = Math.max(0, Math.min(shown, text.length));
    for (let i = 0; i < drawn; i++) {
      let color = base;
      // The glyph that just landed is white-hot, same idiom as the splash wordmark.
      if (shown < text.length && i === drawn - 1) color = GLOW;
      if (shine !== null) {
        const at = (i + 0.5) / text.length;
        const hit = Math.max(0, 1 - Math.abs(at - shine) / 0.22);
        if (hit > 0) color = mixColors(color, GLOW, hit * 0.85);
      }
      const open = bold && i === 0 ? BOLD : "";
      const close = bold && i === drawn - 1 ? BOLD_OFF : "";
      put(start + i, y, `${open}${text[i]}${close}`, foregroundAnsi(color, mode));
    }
  };

  // the mark, settled: no shimmer, this is a resting state
  art.forEach((line, row) => {
    let column = 0;
    for (const char of line) {
      const glyph = LOGO_GLYPHS[char];
      const shades = LOGO_SHADES[char];
      column++;
      if (!glyph || !shades) continue;
      const base = mixColors(shades[0], shades[1], artHeight > 1 ? row / (artHeight - 1) : 0, "srgb");
      put(left + column - 1, startY + row, glyph, foregroundAnsi(base, mode));
    }
  });

  const wordRow = startY + artHeight + 1;
  const titleRow = wordRow + 1;
  const subtitleRow = titleRow + 1;
  const sweepRow = subtitleRow + 2;

  // The wordmark types, the confirmation follows it, one shine crosses both, and the
  // bar fills throughout. Everything but the bar is settled by SHINE_START_MS +
  // SHINE_MS, so the tail of the scene still repaints exactly one row.
  const wordShown = Math.floor((elapsed - WORD_START_MS) / WORD_STEP_MS) + 1;
  const titleShown = Math.floor((elapsed - TITLE_START_MS) / TITLE_STEP_MS) + 1;
  const shineSince = elapsed - SHINE_START_MS;
  const shine = shineSince >= 0 && shineSince <= SHINE_MS ? -0.25 + 1.5 * (shineSince / SHINE_MS) : null;

  writeLine(WORDMARK, wordRow, mixColors(TRAIL, ACCENT, 0.55), false, wordShown, shine);
  // The two lines that carry the message are bold: at this size the thin weights read
  // as a caption, and "Setup saved" has to land as a statement.
  writeLine(TITLE, titleRow, mixColors(ACCENT, GLOW, 0.62), true, titleShown, shine);
  writeLine(
    SUBTITLE,
    subtitleRow,
    mixColors(FAINT, ACCENT, 0.55),
    true,
    elapsed >= SUBTITLE_AT_MS ? SUBTITLE.length : 0,
    null,
  );

  const sweepLeft = Math.floor((w - sweepWidth) / 2);
  const filled = Math.round(progress * sweepWidth);
  for (let i = 0; i < sweepWidth; i++) {
    const done = i < filled;
    put(sweepLeft + i, sweepRow, done ? SWEEP_FILLED : SWEEP_EMPTY, foregroundAnsi(done ? ACCENT : TRAIL, mode));
  }

  return composeFrame(background, cells, w, h);
}

class OutroComponent implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly finish: (skipped: boolean) => void;
  private readonly durationMs: number;
  private readonly tickMs: number;
  private readonly startedAt = performance.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    finish: (skipped: boolean) => void,
    options: SetupOutroOptions = {},
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.finish = finish;
    this.durationMs = options.durationMs ?? SETUP_OUTRO_MS;
    this.tickMs = options.tickMs ?? OUTRO_TICK_MS;
    this.timer = setInterval(() => {
      if (performance.now() - this.startedAt >= this.durationMs) this.close();
      else this.tui.requestRender();
    }, this.tickMs);
    this.timer.unref?.();
  }

  render(width: number): string[] {
    const elapsed = Math.min(this.durationMs, performance.now() - this.startedAt);
    const columns = Math.max(width, this.tui.terminal.columns ?? 0);
    return renderOutro(columns, this.tui.terminal.rows, elapsed, this.theme.getColorMode());
  }

  handleInput(data: string): void {
    // Any key gets on with it: the outro is a confirmation, not a gate.
    if (
      this.keybindings.matches(data, "tui.select.confirm") ||
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === " "
    ) {
      this.close();
    }
  }

  invalidate(): void {}

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    this.finish(true);
  }
}

/** Shows the outro in TUI mode and resolves once it finishes or is dismissed. */
export async function runSetupOutro(ctx: ExtensionContext, options: SetupOutroOptions = {}): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  await ctx.ui.custom<boolean>(
    (tui, theme, keybindings, done) => new OutroComponent(tui, theme, keybindings, done, options),
    {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" },
    },
  );
}
