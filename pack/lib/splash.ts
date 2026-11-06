/**
 * The opening scene of `/setup`, built around NusaGate's mark: the N with a halo
 * of light around it.
 *
 * Scattered specks gather into the N. Then a light draws the halo: it sets off from
 * the left end of the ring, runs along the near arc in front of the letter, swings
 * round behind it and back, and leaves the ring lit behind it. The ring swells
 * once, the wordmark decodes underneath, and while the scene holds a soft glint
 * keeps circling the ring.
 *
 * The halo follows the logo on nusagate.com: a flat ellipse tilted so it rises to
 * the right, crossing the middle of the letter. Its near half passes in front of the
 * N, its far half behind, and it burns brightest on the right, by the green stroke.
 *
 * The scene sits on the terminal's own background. An earlier version painted a
 * glow behind the mark as cell background colour, so every animated row was a full
 * repaint, and the renderer's erase-to-default before each rewrite flickered as
 * black strips on terminals without synchronized output. With no painted background
 * an erased row looks exactly like a drawn one, so motion is free.
 *
 * Every frame is a pure function of (size, elapsed), so the scene is testable
 * without a terminal: see pack/test/splash.test.ts.
 */
import type { Color } from "@earendil-works/pi-tui";
import { foregroundAnsi, mixColors, parseColor } from "@earendil-works/pi-tui";
import { LOGO, GLYPHS as LOGO_GLYPHS, SHADES as LOGO_SHADES } from "../extensions/brand.ts";

/** The wizard moves on after this, unless a key gets there first. */
export const SPLASH_MS = 3_000;
/** Everything has arrived by this point; after it only the halo's glint moves. */
export const SPLASH_SETTLED_MS = 2_250;

type Mode = Parameters<typeof foregroundAnsi>[1];

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

const ACCENT = parseColor("#4ed899");
const GLOW = parseColor("#ecfff6");
const SILVER = parseColor("#dfe8e3");
const FAINT = parseColor("#7c9a8d");
const TRAIL = parseColor("#1a7a55");
const DEEP = parseColor("#0c3d2a");

/** Each speck flies for FLIGHT_MS; starts are staggered so the last lands at GATHER_MS. */
const FLIGHT_MS = 640;
export const GATHER_MS = 1_050;
/** How long a landed cell burns white before it cools to its own colour. */
const FLASH_MS = 160;
/** Specks fade in from nothing over this long, so frame zero is not a wall of dots. */
const DUST_FADE_MS = 220;

/** The light that draws the halo: one lap, starting once the letter is whole. */
export const HALO_START_MS = 1_100;
const HALO_DRAW_MS = 750;
/** The ring swells once when the lap closes. */
const PULSE_START_MS = HALO_START_MS + HALO_DRAW_MS;
const PULSE_MS = 300;
/** While the scene holds, a soft glint circles the ring at this pace. */
const GLINT_START_MS = PULSE_START_MS + PULSE_MS;
const GLINT_LAP_MS = 1_500;
/** Length of the light's tail, as an angle along the ring. */
const TAIL = 1.1;
const GLINT_TAIL = 1.4;
/** How far the light spills onto the letter, in cells. */
const SPILL_RADIUS = 5;

const WORD_NUSA = "Nusa";
const WORD_CODE = "Code";
const WORDMARK = WORD_NUSA + WORD_CODE;
const WORD_START_MS = 1_300;
const WORD_STEP_MS = 55;
/** Each letter flickers through noise this long before it resolves. */
const WORD_SCRAMBLE_MS = 220;
/** ASCII only: a glyph wider than it measures wraps the row. */
const SCRAMBLE = "#%*+=-<>/\\|[]{}?!";

export const TAGLINE = "A coding agent that shows what every prompt costs";
const TAGLINE_START_MS = 1_950;
const TAGLINE_FADE_MS = 300;

export const SKIP_HINT = "press enter to continue";
const HINT_START_MS = SPLASH_SETTLED_MS;

/** Below this there is no room for the mark, and the splash keeps just the words. */
const MIN_ART_WIDTH = 34;

/** Stable noise in [0, 1) for a cell and a channel. */
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(seed + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
const TAU = 2 * Math.PI;
const wrap = (angle: number): number => ((angle % TAU) + TAU) % TAU;

/** The mark, doubled in both axes when the terminal has room for it. */
function markArt(scale: 1 | 2): string[] {
  if (scale === 1) return LOGO;
  return LOGO.flatMap((line) => {
    let wide = "";
    for (const char of line) wide += char === " " ? "  " : `${char}${char}`;
    return [wide, wide];
  });
}

/** Position of one cell along the diagonal from the bottom-left of the mark to the top-right, 0..1. */
function revealOrder(x: number, y: number, width: number, height: number): number {
  return (x + (height - 1 - y)) / Math.max(1, width - 1 + height - 1);
}

interface Layout {
  art: string[];
  scale: 1 | 2;
  artLeft: number;
  artTop: number;
  wordRow: number;
  taglineRow: number;
  hintRow: number;
}

function layout(w: number, h: number): Layout {
  const hintRow = h - 1;
  // Rows above the hint: the mark (the halo stays inside its rows), a gap, the
  // wordmark, a gap, the tagline.
  const usable = Math.max(0, hintRow - 1);
  const big = markArt(2);
  let art: string[] = [];
  let scale: 1 | 2 = 1;
  // The halo reaches a few cells past the letter on both sides, hence the margins.
  if (w >= big[0].length + 14 && usable >= big.length + 5) {
    art = big;
    scale = 2;
  } else if (w >= Math.max(MIN_ART_WIDTH, LOGO[0].length + 10) && usable >= LOGO.length + 4) {
    art = LOGO;
  }
  const block = art.length > 0 ? art.length + 4 : 3;
  const top = Math.max(0, Math.floor((usable - block) / 2));
  const wordRow = art.length > 0 ? top + art.length + 1 : top;
  return {
    art,
    scale,
    artLeft: art.length > 0 ? Math.floor((w - art[0].length) / 2) : 0,
    artTop: top,
    wordRow,
    taglineRow: wordRow + 2,
    hintRow,
  };
}

/** The halo's ellipse, in cell coordinates where a row's centre is its index. */
export interface HaloShape {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** How far the right end rises above the left, halved. */
  tilt: number;
}

export function haloShape(artLeft: number, artTop: number, artWidth: number, artHeight: number, scale: 1 | 2): HaloShape {
  return {
    cx: artLeft + artWidth / 2 - 0.5,
    // A touch above the letter's middle, where the ring crosses it in the logo.
    cy: artTop + (artHeight - 1) * 0.48,
    rx: artWidth / 2 + 2.5 * scale,
    ry: 1.25 * scale,
    tilt: 1.8 * scale,
  };
}

/** A point on the halo at angle θ. θ = 0 is the right end, and sin θ > 0 is the near arc. */
function haloPoint(shape: HaloShape, theta: number): { x: number; y: number } {
  return {
    x: shape.cx + shape.rx * Math.cos(theta),
    y: shape.cy + shape.ry * Math.sin(theta) - shape.tilt * Math.cos(theta),
  };
}

/** One cell of the ring. */
interface HaloCell {
  x: number;
  y: number;
  theta: number;
  glyph: string;
  front: boolean;
}

/**
 * The ring as cells. It is traced at half-row resolution: a point in the upper half
 * of a cell draws `-`, one in the lower half draws `_`, so a slanted ring steps
 * smoothly instead of jumping a whole row at a time. The ends, where the ring turns,
 * are `(` and `)`.
 */
export function haloCells(shape: HaloShape): HaloCell[] {
  const samples = Math.max(360, Math.ceil(TAU * shape.rx * 4));
  const cells = new Map<string, HaloCell>();
  for (let i = 0; i < samples; i++) {
    const theta = (i / samples) * TAU;
    const { x, y } = haloPoint(shape, theta);
    const column = Math.round(x);
    const half = Math.round(y * 2);
    const row = Math.floor(half / 2);
    const cos = Math.cos(theta);
    const glyph = Math.abs(cos) > 0.985 ? (cos > 0 ? ")" : "(") : half % 2 === 0 ? "-" : "_";
    const front = Math.sin(theta) > 0;
    const key = `${column},${row}`;
    const seen = cells.get(key);
    // Where the arcs meet in one cell, the near one wins: it is in front.
    if (seen && (seen.front || !front)) continue;
    cells.set(key, { x: column, y: row, theta, glyph, front });
  }
  return [...cells.values()];
}

/** Where the drawing light is at `elapsed`, as an angle, or null when it is not out. */
function lightAngle(elapsed: number): number | null {
  const p = (elapsed - HALO_START_MS) / HALO_DRAW_MS;
  if (p < 0 || p > 1) return null;
  // From the left end (π) along the near arc to the right end (0), then round the back.
  return Math.PI - TAU * p;
}

function pulseAt(elapsed: number): number {
  const since = elapsed - PULSE_START_MS;
  return since >= 0 && since <= PULSE_MS ? Math.sin((since / PULSE_MS) * Math.PI) : 0;
}

/** Brightness of one ring cell, 0..1, and how far behind the drawing light it is. */
function haloLight(cell: HaloCell, elapsed: number): { level: number; behind: number | null } {
  if (elapsed < HALO_START_MS) return { level: 0, behind: null };
  // The resting ring: brightest on the right, by the green stroke, and on the near arc.
  const side = (Math.cos(cell.theta) + 1) / 2;
  const rest = 0.22 + 0.38 * side + (cell.front ? 0.14 : 0);
  const light = lightAngle(elapsed);
  if (light !== null) {
    // How far behind the light this cell is, along the way it travels.
    const behind = wrap(cell.theta - light);
    const travelled = Math.PI - light;
    if (behind > travelled) return { level: 0, behind: null };
    const comet = Math.max(0, 1 - behind / TAIL) ** 2;
    return { level: Math.max(rest * 0.85, comet), behind };
  }
  const pulse = pulseAt(elapsed);
  let glint = 0;
  if (elapsed >= GLINT_START_MS) {
    const head = Math.PI - TAU * ((elapsed - GLINT_START_MS) / GLINT_LAP_MS);
    glint = 0.55 * Math.max(0, 1 - wrap(cell.theta - head) / GLINT_TAIL) ** 2;
  }
  return { level: clamp01(rest + 0.45 * pulse + glint), behind: null };
}

function haloColor(level: number): Color {
  return level < 0.6 ? mixColors(TRAIL, ACCENT, level / 0.6, "srgb") : mixColors(ACCENT, GLOW, (level - 0.6) / 0.4, "srgb");
}

/** One frame of the splash: exactly `height` rows, each exactly `width` columns wide. */
export function renderSplash(width: number, height: number, elapsedMs: number, mode: Mode = "truecolor"): string[] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const elapsed = Math.max(0, Math.min(SPLASH_MS, elapsedMs));
  const cells: string[][] = Array.from({ length: h }, () => new Array<string>(w).fill(" "));
  const put = (x: number, y: number, glyph: string, color: Color, bold = false): void => {
    if (y < 0 || y >= h || x < 0 || x >= w) return;
    const text = bold ? `${BOLD}${glyph}${BOLD_OFF}` : glyph;
    cells[y]![x] = `${foregroundAnsi(color, mode)}${text}`;
  };

  const { art, scale, artLeft, artTop, wordRow, taglineRow, hintRow } = layout(w, h);
  const artWidth = art.length > 0 ? art[0].length : 0;
  const artHeight = art.length;
  const stagger = GATHER_MS - FLIGHT_MS;

  const shape = art.length > 0 ? haloShape(artLeft, artTop, artWidth, artHeight, scale) : null;
  const ring = shape && elapsed >= HALO_START_MS ? haloCells(shape) : [];
  const lit = ring.map((cell) => ({ cell, ...haloLight(cell, elapsed) })).filter((c) => c.level > 0.04);
  // The cell the light is on gets a star, so the eye can follow it round.
  let headCell: HaloCell | null = null;
  let nearest = 0.2;
  for (const { cell, behind } of lit) {
    if (behind !== null && behind < nearest) {
      nearest = behind;
      headCell = cell;
    }
  }
  // The light's head throws a little of itself onto the letter as it passes.
  const light = lightAngle(elapsed);
  const head = shape && light !== null ? haloPoint(shape, light) : null;

  const drawRing = (front: boolean): void => {
    for (const { cell, level } of lit) {
      if (cell.front !== front) continue;
      const isHead = cell === headCell;
      put(cell.x, cell.y, isHead ? "*" : cell.glyph, isHead ? GLOW : haloColor(level));
    }
  };

  // 1. The far half of the ring, behind everything.
  drawRing(false);

  // 2. The mark. Each cell starts as a speck somewhere on screen and eases home,
  // staggered along the diagonal so the letter assembles as one stroke. Landed
  // cells are drawn after the specks still in flight, so a speck never covers one.
  const landed: (() => void)[] = [];
  art.forEach((line, row) => {
    let column = 0;
    for (const char of line) {
      const col = column++;
      const glyph = LOGO_GLYPHS[char];
      const shades = LOGO_SHADES[char];
      if (!glyph || !shades) continue;
      const homeX = artLeft + col;
      const homeY = artTop + row;
      const order = revealOrder(col, row, artWidth, artHeight);
      const delay = order * stagger;
      const t = clamp01((elapsed - delay) / FLIGHT_MS);
      if (t < 1) {
        const startX = Math.floor(hash(col, row, 1) * w);
        const startY = Math.floor(hash(col, row, 2) * Math.max(1, hintRow));
        const e = easeOutCubic(t);
        const x = Math.round(startX + (homeX - startX) * e);
        const y = Math.round(startY + (homeY - startY) * e);
        const appear = clamp01(elapsed / DUST_FADE_MS) * (0.35 + 0.65 * hash(col, row, 3));
        const color = t > 0 ? mixColors(TRAIL, ACCENT, e, "srgb") : mixColors(DEEP, TRAIL, appear, "srgb");
        put(x, y, t > 0.8 ? "+" : ".", color);
        continue;
      }
      const base = mixColors(shades[0], shades[1], artHeight > 1 ? row / (artHeight - 1) : 0, "srgb");
      const flash = clamp01(1 - (elapsed - (delay + FLIGHT_MS)) / FLASH_MS);
      let spill = 0;
      if (head) {
        const distance = Math.hypot(homeX - head.x, (homeY - head.y) * 2);
        spill = 0.6 * Math.max(0, 1 - distance / (SPILL_RADIUS * scale));
      }
      const glowAmount = Math.max(flash, spill);
      const color = glowAmount > 0 ? mixColors(base, flash >= spill ? GLOW : mixColors(ACCENT, GLOW, 0.5, "srgb"), glowAmount, "srgb") : base;
      landed.push(() => put(homeX, homeY, glyph, color));
    }
  });
  for (const draw of landed) draw();

  // 3. The near half of the ring, across the front of the letter: crossing it is
  // what makes the halo read as going around the N rather than lying behind it.
  drawRing(true);

  // 4. The wordmark decodes letter by letter: noise first, then the real glyph,
  // white for a beat as it lands. "Nusa" takes the mark's silver, "Code" its green.
  if (wordRow < hintRow) {
    const left = Math.floor((w - WORDMARK.length) / 2);
    for (let i = 0; i < WORDMARK.length; i++) {
      const start = WORD_START_MS + i * WORD_STEP_MS;
      if (elapsed < start) continue;
      const settledColor = i < WORD_NUSA.length ? SILVER : ACCENT;
      const since = elapsed - start;
      if (since < WORD_SCRAMBLE_MS) {
        const frame = Math.floor(since / 45);
        const noise = SCRAMBLE[Math.floor(hash(i, frame, 7) * SCRAMBLE.length)];
        put(left + i, wordRow, noise, mixColors(TRAIL, ACCENT, since / WORD_SCRAMBLE_MS, "srgb"));
        continue;
      }
      const cool = clamp01((since - WORD_SCRAMBLE_MS) / 180);
      put(left + i, wordRow, WORDMARK[i], mixColors(GLOW, settledColor, cool, "srgb"), true);
    }
  }

  // 5. The tagline fades up from the dark once the name is readable.
  if (taglineRow < hintRow && elapsed >= TAGLINE_START_MS && TAGLINE.length + 2 <= w) {
    const fade = clamp01((elapsed - TAGLINE_START_MS) / TAGLINE_FADE_MS);
    const color = mixColors(DEEP, FAINT, fade, "srgb");
    const left = Math.floor((w - TAGLINE.length) / 2);
    for (let i = 0; i < TAGLINE.length; i++) if (TAGLINE[i] !== " ") put(left + i, taglineRow, TAGLINE[i], color);
  }

  // 6. The hint, only once there is nothing left to wait for.
  if (elapsed >= HINT_START_MS && h > 1) {
    const hint = SKIP_HINT.length <= w ? SKIP_HINT : "enter";
    const left = Math.max(0, Math.floor((w - hint.length) / 2));
    for (let i = 0; i < hint.length; i++) if (hint[i] !== " ") put(left + i, hintRow, hint[i], mixColors(DEEP, FAINT, 0.7, "srgb"));
  }

  return cells.map((row) => {
    // Collapse repeated colour escapes: plain spaces carry none, so a row costs
    // one escape per change of colour rather than one per cell.
    let line = "";
    let last = "";
    for (const cell of row) {
      const match = /^(\x1b\[[0-9;]*m)(.*)$/s.exec(cell);
      if (!match) {
        line += cell;
        continue;
      }
      if (match[1] !== last) line += match[1];
      last = match[1];
      line += match[2];
    }
    return `${line}${RESET}`;
  });
}
