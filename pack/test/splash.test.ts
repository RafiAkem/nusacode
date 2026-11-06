import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GATHER_MS,
  HALO_START_MS,
  haloCells,
  haloShape,
  renderSplash,
  SKIP_HINT,
  SPLASH_MS,
  SPLASH_SETTLED_MS,
  TAGLINE,
} from "../lib/splash.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]): string[] => lines.map((line) => line.replace(ANSI, ""));
const text = (elapsed: number, width = 100, height = 32): string => plain(renderSplash(width, height, elapsed)).join("\n");
const count = (frame: string, chars: string): number => [...frame].filter((char) => chars.includes(char)).length;

/** Cells that are the letter itself, landed in place. */
const markCells = (elapsed: number, width = 100, height = 32): number => count(text(elapsed, width, height), "#%|");
/** Specks still flying home. */
const specks = (elapsed: number): number => count(text(elapsed), ".+");
/** Cells of the halo. */
const haloGlyphs = (elapsed: number, width = 100, height = 32): number => count(text(elapsed, width, height), "-_()*");

test("a frame fills the requested box exactly", () => {
  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [44, 16],
    [30, 10],
  ]) {
    for (const elapsed of [0, 400, 900, 1_400, 2_000, SPLASH_MS]) {
      const lines = plain(renderSplash(width, height, elapsed));
      assert.equal(lines.length, height, `${width}x${height} rows at ${elapsed}ms`);
      for (const line of lines) assert.equal(line.length, width, `${width}x${height} columns at ${elapsed}ms`);
    }
  }
});

test("specks gather into the letter, and the letter is whole before the halo", () => {
  assert.ok(specks(150) > 50, "the scene opens as scattered specks");
  assert.equal(markCells(0), 0, "nothing has landed on frame zero");
  const early = markCells(700);
  const late = markCells(900);
  const whole = markCells(GATHER_MS);
  assert.ok(early > 0 && early < late && late < whole, `${early} → ${late} → ${whole} landed cells`);
  assert.equal(specks(GATHER_MS), 0, "every speck has landed");
  assert.equal(haloGlyphs(GATHER_MS), 0, "no halo while the letter forms");
});

test("a light draws the halo around the letter, then the ring stays", () => {
  const drawing = [HALO_START_MS + 150, HALO_START_MS + 400, HALO_START_MS + 700].map((t) => haloGlyphs(t));
  assert.ok(drawing[0]! > 0 && drawing[0]! < drawing[1]! && drawing[1]! < drawing[2]!, `the ring grows: ${drawing.join(" → ")}`);
  assert.match(text(HALO_START_MS + 300), /\*/, "the light's head is marked while it draws");
  assert.equal(count(text(HALO_START_MS + 300), "*"), 1, "one head");
  const settled = text(SPLASH_MS);
  assert.doesNotMatch(settled, /\*/, "no head once the lap is done");
  assert.match(settled, /\(/);
  assert.match(settled, /\)/);
  assert.ok(haloGlyphs(SPLASH_MS) >= drawing[2]!, "the whole ring stays lit");
});

test("the halo rises to the right and its near arc crosses in front of the letter", () => {
  const lines = plain(renderSplash(100, 32, SPLASH_MS));
  const rowOf = (char: string): number => lines.findIndex((line) => line.includes(char));
  assert.ok(rowOf(")") < rowOf("("), "the right end sits higher than the left");
  // Over the letter means a ring glyph with letter glyphs on both sides of it.
  assert.ok(lines.some((line) => /[#%|][-_]+[#%|]/.test(line)), "the ring passes over the N");
});

test("the halo's near arc wins where both arcs share a cell", () => {
  const shape = haloShape(10, 5, 24, 11, 1);
  const cells = haloCells(shape);
  const keys = new Set(cells.map((c) => `${c.x},${c.y}`));
  assert.equal(keys.size, cells.length, "one entry per cell");
  assert.ok(cells.some((c) => c.front) && cells.some((c) => !c.front));
});

test("the wordmark decodes, then reads NusaCode", () => {
  assert.doesNotMatch(text(1_200), /NusaCode/);
  assert.doesNotMatch(text(1_500), /NusaCode/, "still decoding");
  assert.match(text(2_000), /NusaCode/);
});

test("the tagline and the hint arrive after the name", () => {
  assert.doesNotMatch(text(1_800), new RegExp(TAGLINE));
  assert.match(text(2_300), new RegExp(TAGLINE));
  assert.doesNotMatch(text(2_000), new RegExp(SKIP_HINT));
  assert.match(text(SPLASH_SETTLED_MS), new RegExp(SKIP_HINT));
});

test("once settled only the halo's light moves", () => {
  const raw = (t: number): string => renderSplash(100, 32, t).join("\n");
  assert.equal(text(SPLASH_SETTLED_MS), text(SPLASH_MS), "no glyph changes after it settles");
  assert.notEqual(raw(SPLASH_SETTLED_MS), raw(SPLASH_MS), "the glint keeps circling");
  assert.equal(raw(1_500), raw(1_500), "the same instant renders the same frame");
});

test("elapsed time is clamped to the splash duration", () => {
  assert.deepEqual(renderSplash(80, 24, SPLASH_MS * 5), renderSplash(80, 24, SPLASH_MS));
});

test("a big terminal doubles the mark, a small one keeps the words", () => {
  assert.match(text(SPLASH_MS, 130, 40), /####/);
  const small = text(SPLASH_MS, 30, 10);
  assert.match(small, /NusaCode/);
  assert.equal(markCells(SPLASH_MS, 30, 10), 0, "no room for the mark");
  assert.equal(haloGlyphs(SPLASH_MS, 30, 10), 0, "and so no halo");
});

test("the mark is centred", () => {
  const lines = plain(renderSplash(80, 24, GATHER_MS));
  const row = lines.find((line) => line.includes("%%%%%"));
  assert.ok(row, "the mark is drawn");
  const left = row.search(/[#%|]/);
  const right = row.length - 1 - Math.max(row.lastIndexOf("#"), row.lastIndexOf("%"), row.lastIndexOf("|"));
  assert.ok(Math.abs(left - right) <= 12, `margins ${left} and ${right}`);
});

test("degenerate sizes render instead of throwing", () => {
  for (const [width, height] of [
    [1, 1],
    [8, 3],
    [200, 4],
  ]) {
    for (const elapsed of [600, 1_500, SPLASH_MS]) {
      const lines = plain(renderSplash(width, height, elapsed));
      assert.equal(lines.length, height);
      for (const line of lines) assert.equal(line.length, width);
    }
  }
});

test("no glyph is wider than the terminal thinks it is", () => {
  // A character that reports width 1 but renders as 2 pushes its row past the
  // terminal width and wraps it. The splash is ASCII only.
  for (let elapsed = 0; elapsed <= SPLASH_MS; elapsed += 40) {
    for (const char of text(elapsed, 120, 30)) {
      if (char === "\n") continue;
      assert.ok(char.codePointAt(0)! < 128, `U+${char.codePointAt(0)!.toString(16)} at ${elapsed}ms`);
    }
  }
});

test("no row paints a background colour", () => {
  // An animated painted background made every row a full repaint, which flickered
  // as black strips on terminals without synchronized output.
  for (let elapsed = 0; elapsed <= SPLASH_MS; elapsed += 200) {
    for (const line of renderSplash(80, 24, elapsed)) assert.doesNotMatch(line, /\x1b\[48;/);
  }
});
