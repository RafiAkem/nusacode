/**
 * `/setup` splash: the N is drawn by a light that traces the letterform, a comet
 * crosses the ring around it once, then the mark settles into a slow shimmer.
 *
 * No water, no starfield, no full-screen gradient sweep. The letter is the
 * animation: cells appear along a diagonal front with a lit leading edge, the ring
 * is the same halo that orbits the N in the welcome header, and the settled state
 * breathes rather than loops a scene.
 *
 * Behind all of it sits a soft radial glow: a single light source behind the mark,
 * painted as cell background colour rather than characters, so the splash reads as
 * a designed frame instead of a scrolling scene. It breathes very slightly, which
 * keeps the settled state alive without anything moving.
 *
 * Every frame is a pure function of (size, elapsed), so the whole thing is testable
 * without a terminal — see pack/test/splash.test.ts.
 */
import type { Color, Component, TUI } from "@earendil-works/pi-tui";
import { backgroundAnsi, foregroundAnsi, mixColors, parseColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { LOGO, GLYPHS as LOGO_GLYPHS, SHADES as LOGO_SHADES } from "../extensions/brand.ts";

export const SETUP_SPLASH_MS = 2_600;
export const SPLASH_TICK_MS = 40;

/** Timing overrides, for tests and for anyone who wants a shorter wait. */
export interface SetupSplashOptions {
  readonly durationMs?: number;
  readonly tickMs?: number;
}

const RESET = "\x1b[0m";

/** Palette: the deep end of the N's green, its accent, and the halo core. */
const DEEP = parseColor("#0c6e4a");
const ACCENT = parseColor("#4ed899");
const GLOW = parseColor("#ecfff6");
const FAINT = parseColor("#7c9a8d");
const TRAIL = parseColor("#1a7a55");

/** The letter is fully drawn by this point; everything after is settle. */
const REVEAL_MS = 950;
const COMET_START_MS = 430;
const COMET_MS = 1_450;
const WORD_START_MS = 940;
const WORD_STEP_MS = 42;
const HINT_START_MS = 1_500;

/** Below this the scene drops its ring and keeps the letter, the word and the hint. */
const MIN_SCENE_WIDTH = 44;
const MIN_SCENE_HEIGHT = 16;

/** Comet trail ramp, faint to the head. */
const TRAIL_RAMP = ".-~=*";

/** Clearance between the letter's box and the ring, in cells. */
const ORBIT_PAD_X = 4.5;
/** Ring thickness in cells, measured radially. */
const ORBIT_THICKNESS = 0.75;
/** How far the ring leans: the projection of a tilted circle, in cells. */
const ORBIT_TILT = 1.2;
/** Fraction of the ring the comet's tail covers behind the head. */
const TAIL_FRACTION = 0.45;
/** The orbit path shows itself before the comet arrives, so the motion reads. */
const RING_SHOW_MS = 240;
/**
 * A last beat before the splash goes away: the ring swells once, then everything
 * fades to the background colour. Without it the loading screen just stops and the
 * next prompt appears, which reads as a crash rather than a finish.
 */
const PULSE_START_MS = 1_880;
const PULSE_MS = 300;
/** Length of the fade to background at the very end. */
const FADE_MS = 240;

const WORDMARK = "NusaCode";

/**
 * Background: a soft radial glow behind the mark, painted as cell *background colour*
 * rather than characters. Nothing falls, nothing scrolls — it is light, not a scene.
 */
const BG_EDGE = parseColor("#061a12");
const BG_CORE = parseColor("#0f3f2c");
/** How far the glow reaches, as a fraction of the terminal, so it scales with the frame. */
const GLOW_SPREAD_X = 0.40;
const GLOW_SPREAD_Y = 0.48;
/** Higher = tighter core, faster falloff. */
const GLOW_FALLOFF = 1.15;
/**
 * The glow is deliberately static. An animated background changes every cell every
 * tick, which makes the renderer treat every row as dirty: it erases each one with
 * `\x1b[2K` (default background, i.e. black) and rewrites it, and on terminals that
 * do not honour synchronized updates that reads as black strips flickering at the
 * frame rate. A still background means a settled splash repaints nothing at all.
 */
/**
 * How many shades the gradient is quantised to. Each level costs one SGR run per
 * row segment, so this is the knob that trades smoothness against how much escape
 * traffic the terminal has to swallow every frame.
 */
const GLOW_STEPS = 20;
/** Halftone lattice over the glow: a regular grid, so it reads as texture. */
const DOT_STEP_X = 3;
const DOT_OFFSET_X = 1;
const DOT_STEP_Y = 2;
const DOT_GLYPH = ".";
/** Dots only exist where the light reaches; past this they would be pure noise. */
const DOT_MIN_GLOW = 0.3;

type Mode = Parameters<typeof foregroundAnsi>[1];

/**
 * Strength of the glow at one cell, 0..1. Pure in (position, size, time): the frame
 * stays reproducible, which is what lets the tests assert on it.
 */
export function glowIntensity(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
): number {
  const nx = (x - centerX) / Math.max(1, radiusX);
  const ny = (y - centerY) / Math.max(1, radiusY);
  return Math.exp(-(nx * nx + ny * ny) * GLOW_FALLOFF);
}

/** Edge-of-screen green fading to the glow's core green. */
export function glowColor(intensity: number): Color {
  return mixColors(BG_EDGE, BG_CORE, Math.min(1, Math.max(0, intensity)), "srgb");
}

/** A pre-painted background: one glow level per cell, plus the escape for each level. */
export interface GlowBackground {
  readonly levels: number[][];
  readonly levelAnsi: string[];
}

/**
 * The glow as a grid of quantised levels. Quantising is what keeps the escape count
 * sane: one background escape per level change along a row, not one per cell.
 */
export function glowBackground(
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  mode: Mode,
  fade = 1,
): GlowBackground {
  const levelAnsi: string[] = [];
  for (let level = 0; level <= GLOW_STEPS; level++) {
    levelAnsi.push(backgroundAnsi(glowColor(level / GLOW_STEPS), mode));
  }
  const levels: number[][] = [];
  for (let y = 0; y < height; y++) {
    const levelRow: number[] = [];
    for (let x = 0; x < width; x++) {
      const strength = glowIntensity(x, y, centerX, centerY, radiusX, radiusY);
      levelRow.push(Math.round(Math.min(1, Math.max(0, strength)) * GLOW_STEPS * fade));
    }
    levels.push(levelRow);
  }
  return { levels, levelAnsi };
}

/** Turn a glyph grid into rows: one background escape per level change, then the cell. */
export function composeFrame(background: GlowBackground, cells: string[][], width: number, height: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < height; y++) {
    let line = "";
    let level = -1;
    for (let x = 0; x < width; x++) {
      const cellLevel = background.levels[y]![x] as number;
      if (cellLevel !== level) {
        line += background.levelAnsi[cellLevel];
        level = cellLevel;
      }
      line += cells[y]![x] || " ";
    }
    out.push(`${line}${RESET}`);
  }
  return out;
}

function padLine(line: string, width: number): string {
  const fitted = truncateToWidth(line, width, "");
  const missing = width - visibleWidth(fitted);
  return missing > 0 ? fitted + " ".repeat(missing) : fitted;
}

function centerLine(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return " ".repeat(left) + text;
}

/** The mark, doubled in both axes when the terminal has room for it. */
function markArt(scale: 1 | 2): string[] {
  if (scale === 1) return LOGO;
  return LOGO.flatMap((line) => {
    let wide = "";
    for (const char of line) wide += char === " " ? "  " : `${char}${char}`;
    return [wide, wide];
  });
}

/**
 * Reveal order of one cell, 0..1: a diagonal front sweeping from the bottom-left
 * corner of the letter to the top-right, so the light reads as one stroke.
 */
function revealOrder(x: number, y: number, width: number, height: number): number {
  const span = Math.max(1, width - 1 + height - 1);
  return (x + (height - 1 - y)) / span;
}

/** One lit cell of the orbit, in screen coordinates. */
interface OrbitCell {
  x: number;
  y: number;
  intensity: number;
  /** Comet brightness on this cell, 0 for the plain ring track. */
  trail: number;
  /** The near half of the ring passes in front of the letter. */
  front: boolean;
  /** The comet's head gets its own glyph, so the eye can follow it. */
  head: boolean;
}

/** The closing swell, 0..1: one sine hump when the splash is finishing. */
function pulseAt(elapsed: number): number {
  const since = elapsed - PULSE_START_MS;
  return since >= 0 && since <= PULSE_MS ? Math.sin((since / PULSE_MS) * Math.PI) : 0;
}

/**
 * The ring around the letter plus the comet travelling on it. The path appears
 * before the comet does, at a faint intensity, so the orbit reads as a track
 * rather than a streak that happens to pass by.
 */
function orbitCells(
  originX: number,
  originY: number,
  artWidth: number,
  artHeight: number,
  elapsed: number,
  width: number,
  height: number,
  maxY: number,
): OrbitCell[] {
  const centerX = originX + artWidth / 2 - 0.5;
  const centerY = originY + artHeight / 2 - 0.5;
  const radiusX = artWidth / 2 + ORBIT_PAD_X;
  // A terminal cell is about twice as tall as it is wide, so a ring that *looks*
  // round needs radiusY ≈ radiusX / 2. Clamp it to the rows that actually exist.
  // Flatter than a circle on purpose: the near arc has to cross the letter's body,
  // not clear it, or the ring reads as a halo lying behind a cut-out instead of an
  // orbit going around it.
  const room = Math.max(2, Math.min(centerY + 1, maxY - centerY));
  const radiusY = Math.max(2, Math.min(artHeight * 0.26, room));

  const since = elapsed - COMET_START_MS;
  const active = since >= 0 && since <= COMET_MS;
  const head = (since / COMET_MS) * 2 * Math.PI - Math.PI / 2;
  const fade = active ? 1 - Math.max(0, (since - COMET_MS * 0.7) / (COMET_MS * 0.3)) : 0;
  // One swell of the whole ring as the splash finishes: a visible "done" beat.
  const pulse = pulseAt(elapsed);
  const track = elapsed >= RING_SHOW_MS ? 0.24 + 1.0 * pulse : 0;
  const tail = TAIL_FRACTION * 2 * Math.PI;

  const cells: OrbitCell[] = [];
  const top = Math.max(0, Math.floor(centerY - radiusY));
  const bottom = Math.min(height - 1, Math.ceil(centerY + radiusY), maxY - 1);
  const left = Math.max(0, Math.floor(centerX - radiusX));
  const right = Math.min(width - 1, Math.ceil(centerX + radiusX));
  // Rasterise the band cell by cell instead of sampling angles: sampling leaves
  // gaps and clusters wherever the ellipse is steep, which reads as a dashed mess.
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const nx = (x - centerX) / radiusX;
      const ny = (y - centerY - ORBIT_TILT * nx) / radiusY;
      // Distance to the ellipse in *cell* units, not in normalised units. The
      // ellipse is far wider than it is tall, so |d-1| scaled by radiusX alone
      // reports "far" at the top and bottom of the curve and leaves the ring
      // dashed there. Dividing by the gradient makes the thickness isotropic.
      const field = nx * nx + ny * ny - 1;
      const gradient = 2 * Math.sqrt((nx / radiusX) ** 2 + (ny / radiusY) ** 2);
      const distance = gradient > 1e-9 ? Math.abs(field) / gradient : Infinity;
      if (distance > ORBIT_THICKNESS) continue;
      const angle = (Math.atan2(ny, nx) + 2 * Math.PI) % (2 * Math.PI);
      let behind = (head - angle) % (2 * Math.PI);
      if (behind < 0) behind += 2 * Math.PI;
      const comet = active && behind <= tail ? (1 - behind / tail) ** 2 * fade : 0;
      // Near arc brighter, far arc dimmer: that contrast plus the front arc being
      // drawn over the letter is what makes the ring read as passing around it.
      const intensity = Math.max(comet, ny > 0 ? track * 1.15 : track * 0.8);
      if (intensity <= 0.05) continue;
      cells.push({ x, y, intensity, trail: comet, front: ny > 0, head: active && behind < 0.1 && comet > 0.3 });
    }
  }
  return cells;
}

function orbitGlyph(cell: OrbitCell): string {
  // ASCII only, on purpose. The comet head used to be U+2726 (✦), which reports a
  // width of 1 but is East-Asian-Ambiguous: terminals whose monospace font lacks it
  // fall back to another font and draw it two cells wide. That one extra cell pushes
  // the row past the terminal width, wraps it, and the row ends up erased — a black
  // band across the splash. Nothing here may be wider than it measures.
  if (cell.head) return "*";
  // Only the comet uses the density ramp; the ring's own track is always a dot, so
  // a brighter near arc does not turn into a dashed line of punctuation.
  if (cell.trail <= 0.06) return "·";
  const index = Math.min(TRAIL_RAMP.length - 1, Math.max(0, Math.floor(cell.trail * TRAIL_RAMP.length)));
  return TRAIL_RAMP[index];
}

function trailColor(intensity: number): Color {
  return intensity < 0.5
    ? mixColors(TRAIL, ACCENT, intensity * 2, "srgb")
    : mixColors(ACCENT, GLOW, (intensity - 0.5) * 2, "srgb");
}

/**
 * One frame: the letter revealed up to a moving front, the ring and its comet, the
 * wordmark typing itself out, then a settled shimmer.
 */
export function renderSplash(width: number, height: number, elapsedMs: number, mode: Mode = "truecolor"): string[] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const elapsed = Math.max(0, Math.min(SETUP_SPLASH_MS, elapsedMs));
  const full = w >= MIN_SCENE_WIDTH && h >= MIN_SCENE_HEIGHT;
  const art = full ? markArt(w >= 62 && h >= 30 ? 2 : 1) : markArt(1);
  const artWidth = Math.max(...art.map((line) => visibleWidth(line)));
  const artHeight = art.length;

  // Full scene: one clear row under the ring for the wordmark, so the orbit owns the
  // full height. Compact: the hint owns the bottom row and the mark only appears
  // when the rows above the wordmark can hold it whole.
  let originY: number;
  let wordRow: number;
  let showArt: boolean;
  if (full) {
    wordRow = Math.max(artHeight + 3, h - 3);
    originY = Math.max(0, Math.floor((wordRow - 1 - artHeight) / 2));
    showArt = true;
  } else {
    wordRow = h - 2;
    const available = Math.max(0, wordRow - 1);
    showArt = available >= artHeight;
    originY = showArt ? Math.max(0, Math.floor((available - artHeight) / 2)) : 0;
  }
  const originX = Math.floor((w - artWidth) / 2);

  // A steady sweep, not an ease-out: the light should read as one stroke, and an
  // eased front lands 80% of the letter in the first third of the time.
  const front = Math.min(1.15, (elapsed / REVEAL_MS) * 1.15);
  // The letter lifts into place while it is being drawn: three rows of travel,
  // gone before the wordmark starts, so the two never collide.
  const lift = Math.round(3 * (1 - Math.min(1, elapsed / 620)));
  const settled = elapsed >= REVEAL_MS;

  // The last FADE_MS the whole scene sinks into the background colour, so the splash
  // ends rather than stopping: without it the frame is swapped for the next prompt
  // mid-breath and the cut reads as a crash.
  const fadeStart = SETUP_SPLASH_MS - FADE_MS;
  const fade = elapsed <= fadeStart ? 1 : Math.max(0, 1 - (elapsed - fadeStart) / FADE_MS);
  const dim = (color: Color): Color => (fade >= 1 ? color : mixColors(BG_EDGE, color, fade, "srgb"));

  // The background is colour, not characters: every cell sits on its slice of the
  // glow, so the mark is inside light instead of inside noise. The glow is quantised
  // into GLOW_STEPS levels and a background escape is only emitted when the level
  // changes along a row: a per-cell escape means ~3000 SGR runs per frame, which
  // some terminals (Windows Terminal behind ConPTY) drop part of, and the dropped
  // cells show up as black specks in the gradient.
  const centerX = originX + artWidth / 2 - 0.5;
  const centerY = originY + lift + artHeight / 2 - 0.5;
  const radiusX = Math.max(6, w * GLOW_SPREAD_X);
  const radiusY = Math.max(4, h * GLOW_SPREAD_Y);
  const background = glowBackground(w, h, centerX, centerY, radiusX, radiusY, mode, fade);
  const cells: string[][] = Array.from({ length: h }, () => new Array<string>(w).fill(""));
  const put = (x: number, y: number, glyph: string, foreground?: string): void => {
    if (y < 0 || y >= h || x < 0 || x >= w) return;
    cells[y][x] = `${foreground ?? ""}${glyph}`;
  };

  // 1. the far half of the ring, behind the letter
  const orbit = full ? orbitCells(originX, originY, artWidth, artHeight, elapsed, w, h, wordRow) : [];

  // 2. the letter, revealed cell by cell with a lit leading edge. Collected first so
  // the rain field can be told where the mark is and keep its moat.
  const artCells: { x: number; y: number; glyph: string; color: Color }[] = [];
  if (showArt) art.forEach((line, row) => {
    let column = 0;
    for (const char of line) {
      const x = originX + column;
      const y = originY + lift + row;
      column++;
      const shades = LOGO_SHADES[char];
      const glyph = LOGO_GLYPHS[char];
      if (!shades || !glyph || y < 0 || y >= h || x < 0 || x >= w) continue;
      const order = revealOrder(column - 1, row, artWidth, artHeight);
      if (order > front) continue;
      const base = mixColors(shades[0], shades[1], artHeight > 1 ? row / (artHeight - 1) : 0, "srgb");
      // Leading edge of the reveal is white-hot; settled cells only shimmer.
      const edge = order > front - 0.16 ? 1 - (front - order) / 0.16 : 0;
      // Static once settled: a shimmer that moves every frame would mark every row
      // dirty and make the renderer erase/redraw the whole screen 25 times a second.
      const shimmer = settled ? 0.12 + 0.12 * Math.sin(order * 9) : 0;
      const lit = Math.min(1, Math.max(edge, shimmer + 0.05));
      const color = lit > 0.02 ? mixColors(base, GLOW, lit * 0.85, "srgb") : base;
      artCells.push({ x, y, glyph, color: dim(color) });
    }
  });

  // 3. a halftone lattice: a regular grid of dim dots that fades out with the glow.
  // Regular spacing is what keeps it reading as texture instead of falling code.
  {
    const occupied = new Set<number>();
    for (const cell of artCells) occupied.add(cell.y * w + cell.x);
    for (const cell of orbit) occupied.add(cell.y * w + cell.x);
    const nearMark = (x: number, y: number): boolean => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          if (occupied.has(ny * w + nx)) return true;
        }
      }
      return false;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x % DOT_STEP_X !== DOT_OFFSET_X || y % DOT_STEP_Y !== 0) continue;
        const strength = glowIntensity(x, y, centerX, centerY, radiusX, radiusY);
        if (strength < DOT_MIN_GLOW) continue;
        if (nearMark(x, y)) continue;
        const color = dim(mixColors(BG_EDGE, ACCENT, 0.08 + 0.34 * strength, "srgb"));
        put(x, y, DOT_GLYPH, foregroundAnsi(color, mode));
      }
    }
  }

  // 4. the far half of the ring
  for (const cell of orbit) {
    if (cell.front) continue;
    const back = dim(mixColors(TRAIL, ACCENT, Math.min(1, cell.intensity * 1.6)));
    put(cell.x, cell.y, orbitGlyph(cell), foregroundAnsi(back, mode));
  }

  // 4. the letter
  for (const cell of artCells) {
    put(cell.x, cell.y, cell.glyph, foregroundAnsi(cell.color, mode));
  }

  // 5. the near half of the ring, drawn over the letter: it has to cross in front
  // of the N, otherwise the ring reads as lying behind a flat cut-out.
  for (const cell of orbit) {
    if (!cell.front) continue;
    // The near arc is lit: it crosses the letter, so it has to out-read it.
    const near = dim(cell.trail > 0.06 ? trailColor(cell.trail) : mixColors(ACCENT, GLOW, 0.55 + 0.45 * pulseAt(elapsed)));
    put(cell.x, cell.y, orbitGlyph(cell), foregroundAnsi(near, mode));
  }

  // 6. the wordmark, one letter at a time
  const wordLeft = Math.floor((w - WORDMARK.length) / 2);
  const shown = Math.max(0, Math.floor((elapsed - WORD_START_MS) / WORD_STEP_MS) + 1);
  for (let i = 0; i < Math.min(shown, WORDMARK.length); i++) {
    const newest = i === shown - 1 && elapsed < WORD_START_MS + WORDMARK.length * WORD_STEP_MS;
    put(wordLeft + i, wordRow, WORDMARK[i], foregroundAnsi(dim(newest ? GLOW : ACCENT), mode));
  }

  // 7. the skip hint, only once the letter is on screen
  if (elapsed >= HINT_START_MS && h > 1) {
    const hint = "press enter to skip";
    const hintLeft = Math.max(0, Math.floor((w - hint.length) / 2));
    for (let i = 0; i < hint.length; i++) {
      put(hintLeft + i, h - 1, hint[i], foregroundAnsi(dim(FAINT), mode));
    }
  }

  return composeFrame(background, cells, w, h);
}

class SplashComponent implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly finish: (skipped: boolean) => void;
  private readonly durationMs: number;
  private readonly tickMs: number;
  private readonly startedAt = performance.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  // Explicit fields, not constructor parameter properties: Node's strip-only
  // TypeScript loader (used by `npm test`) rejects those.
  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    finish: (skipped: boolean) => void,
    options: SetupSplashOptions = {},
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.finish = finish;
    this.durationMs = options.durationMs ?? SETUP_SPLASH_MS;
    this.tickMs = options.tickMs ?? SPLASH_TICK_MS;
    this.timer = setInterval(() => {
      if (performance.now() - this.startedAt >= this.durationMs) this.close();
      else this.tui.requestRender();
    }, this.tickMs);
    this.timer.unref?.();
  }

  render(width: number): string[] {
    const elapsed = Math.min(this.durationMs, performance.now() - this.startedAt);
    // Use the terminal's own width when it is wider than the box we were handed: the
    // overlay can be sized one cell short of the screen, and every cell it does not
    // cover keeps the default background, which reads as a black column at the edge.
    // Anything past the overlay's width is clipped by the compositor.
    const columns = Math.max(width, this.tui.terminal.columns ?? 0);
    return renderSplash(columns, this.tui.terminal.rows, elapsed, this.theme.getColorMode());
  }

  handleInput(data: string): void {
    const skip =
      this.keybindings.matches(data, "tui.select.confirm") ||
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === " ";
    if (skip) this.close();
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

/** Shows the splash in TUI mode and resolves once it finishes or is skipped. */
export async function runSetupSplash(ctx: ExtensionContext, options: SetupSplashOptions = {}): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  // Overlay, not inline: an inline component is laid out in the transcript, above
  // the header and editor. The splash is a full-height frame, so inline it would
  // overflow the viewport on every tick and drag the terminal into a scroll storm.
  // As an overlay it is composited over the viewport instead, and disappears whole.
  await ctx.ui.custom<boolean>(
    (tui, theme, keybindings, done) => new SplashComponent(tui, theme, keybindings, done, options),
    {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" },
    },
  );
}
