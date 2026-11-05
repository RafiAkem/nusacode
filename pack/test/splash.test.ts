import { after, test } from "node:test";
import assert from "node:assert/strict";
import { glowIntensity, renderSplash, runSetupSplash, SETUP_SPLASH_MS } from "../lib/splash.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// The scenes' timers are unref'd so they can't hold the CLI open. Without this, Node 22
// sees an empty event loop while a test awaits one and cancels the test.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]): string[] => lines.map((line) => line.replace(ANSI, ""));
const text = (elapsed: number, width = 80, height = 24): string => plain(renderSplash(width, height, elapsed)).join("\n");

/** Cells that belong to the letter itself, not to the ring or the wordmark. */
function markCells(elapsed: number): number {
  return text(elapsed)
    .split("")
    .filter((char) => char === "#" || char === "%" || char === "|").length;
}

test("a frame fills the requested box exactly", () => {
  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [44, 16],
  ]) {
    const lines = renderSplash(width, height, 900);
    assert.equal(lines.length, height, `${width}x${height} rows`);
    for (const line of plain(lines)) assert.equal(line.length, width, `${width}x${height} columns`);
  }
});

test("the letter draws itself in, then stops growing", () => {
  const early = markCells(120);
  const middle = markCells(500);
  const done = markCells(900);
  assert.ok(early > 0, "the first cells appear early");
  assert.ok(early < middle, `${early} cells at 120ms, ${middle} at 500ms`);
  assert.ok(middle < done, `${middle} cells at 500ms, ${done} at 900ms`);
  assert.equal(markCells(2_000), done, "the letter does not grow after it is drawn");
});

test("the comet crosses the ring and then leaves", () => {
  const during = Array.from({ length: 8 }, (_, i) => text(1_100 + i * 100));
  assert.ok(
    during.some((frame) => /[*=~]/.test(frame)),
    "trail glyphs appear while the comet passes",
  );
  assert.doesNotMatch(text(2_400), /[*=~]/, "no trail left behind");
});

test("the ring shows itself before the comet arrives", () => {
  assert.doesNotMatch(text(200), /·/, "no ring while the letter is still drawing");
  assert.match(text(1_050), /·/, "the orbit path shows itself");
});

test("the wordmark types itself out one letter at a time", () => {
  assert.doesNotMatch(text(900), /Nusa/);
  assert.match(text(1_100), /Nus/);
  assert.doesNotMatch(text(1_100), /NusaCode/);
  assert.match(text(1_600), /NusaCode/);
});

test("the skip hint waits until the letter is on screen", () => {
  assert.doesNotMatch(text(1_300), /press enter to skip/);
  assert.match(text(1_700), /press enter to skip/);
});

test("the settled mark keeps breathing, and the same instant renders the same frame", () => {
  // Breathing is a brightness change, so it only shows in the coloured output.
  const raw = (t: number): string => renderSplash(80, 24, t).join("\n");
  assert.notEqual(raw(1_800), raw(2_100));
  assert.equal(raw(2_100), raw(2_100));
  assert.match(text(2_400), /·/, "the orbit stays visible after the comet leaves");
});

test("elapsed time is clamped to the splash duration", () => {
  assert.deepEqual(renderSplash(80, 24, SETUP_SPLASH_MS * 5), renderSplash(80, 24, SETUP_SPLASH_MS));
});

test("the glow is a light behind the mark, not a texture", () => {
  const centre = glowIntensity(40, 12, 40, 12, 30, 8);
  const edge = glowIntensity(0, 0, 40, 12, 30, 8);
  assert.ok(centre > 0.9, `centre should be near full strength, got ${centre.toFixed(2)}`);
  assert.ok(edge < 0.25, `corners should be near dark, got ${edge.toFixed(2)}`);
  assert.ok(centre > edge * 4, "the falloff has to be steep enough to read as light");
});

test("the scene settles between the closing pulse and the fade", () => {
  // Every changed row costs a `\x1b[2K` (erased to the default background) plus a
  // rewrite, so nothing may repaint while nothing is moving: the splash animates,
  // then holds still, then fades — it never strobes in place.
  const held = renderSplash(120, 30, 2_200).join("\n");
  assert.equal(renderSplash(120, 30, 2_300).join("\n"), held, "the held frame must not change");
  assert.notEqual(renderSplash(120, 30, 2_500).join("\n"), held, "the fade has to move");
});

test("every cell carries its own background, so nothing shows through from behind", () => {
  for (const line of renderSplash(80, 24, 1_600)) {
    assert.match(line, /^\x1b\[48;/, "each row starts with a background colour");
    // A glyph without a background escape in front of it would punch a hole through
    // to the menu underneath.
    const glyphs = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(glyphs.length, 80);
  }
});

test("a big terminal doubles the mark", () => {
  assert.match(text(900, 120, 40), /##/);
});

test("a small terminal keeps the letter, the wordmark and the hint", () => {
  const lines = plain(renderSplash(30, 10, 1_600));
  assert.equal(lines.length, 10);
  for (const line of lines) assert.equal(line.length, 30);
  const joined = lines.join("\n");
  assert.match(joined, /NusaCode/);
  assert.match(joined, /press enter to skip/);
});

test("the compact mark is centred, not flush left", () => {
  const lines = plain(renderSplash(40, 14, 900));
  const artRow = lines.find((line) => line.includes("%%%%%"));
  assert.ok(artRow, "the mark is drawn");
  const column = artRow.indexOf("%%%%%");
  assert.ok(column > 5, `mark starts at column ${column}`);
  assert.ok(column < 40 - 5, "mark ends inside the box");
});

test("degenerate sizes render instead of throwing", () => {
  for (const [width, height] of [
    [1, 1],
    [8, 3],
    [200, 4],
  ]) {
    const lines = renderSplash(width, height, 100);
    assert.equal(lines.length, height);
    for (const line of plain(lines)) assert.equal(line.length, width);
  }
});

type FakeUi = {
  renders: number;
  component: { render(width: number): string[]; handleInput(data: string): void } | null;
  options: { overlay?: boolean; overlayOptions?: Record<string, unknown> } | null;
};

/** A ctx whose custom() runs the factory once and settles when the component calls done. */
function fakeContext(matches: (data: string, binding: string) => boolean): { ctx: ExtensionContext; ui: FakeUi } {
  const ui: FakeUi = { renders: 0, component: null, options: null };
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom: (
        factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: boolean) => void) => FakeUi["component"],
        options: FakeUi["options"],
      ) =>
        new Promise<boolean>((resolve) => {
          ui.options = options ?? null;
          ui.component = factory(
            { terminal: { rows: 24 }, requestRender: () => void ui.renders++ },
            { getColorMode: () => "truecolor" },
            { matches },
            resolve,
          );
        }),
    },
  } as unknown as ExtensionContext;
  return { ctx, ui };
}

test("the splash closes itself when the timer runs out", async () => {
  const { ctx, ui } = fakeContext(() => false);
  const started = performance.now();
  await runSetupSplash(ctx, { durationMs: 120, tickMs: 20 });
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 100, `waited for the scene, got ${elapsed}ms`);
  assert.ok(elapsed < 2_000, `did not overrun, got ${elapsed}ms`);
  assert.ok(ui.renders >= 2, `repainted each tick, got ${ui.renders}`);
  assert.equal(ui.component?.render(80).length, 24);
});

test("enter skips the splash without waiting for the timer", async () => {
  const { ctx, ui } = fakeContext(() => true);
  const running = runSetupSplash(ctx, { durationMs: 60_000, tickMs: 1_000 });
  const started = performance.now();
  ui.component?.handleInput("\r");
  await running;
  assert.ok(performance.now() - started < 500, "resolved on the keypress");
});

test("no glyph is wider than the terminal thinks it is", () => {
  // A character that reports width 1 but renders as 2 pushes its row past the
  // terminal width, wraps it, and the row comes back blank — the splash shows a
  // black band. U+2726 (✦) did exactly that, so only these may appear.
  const safe = new Set(["·"]);
  const seen = new Set<string>();
  for (let elapsed = 0; elapsed <= SETUP_SPLASH_MS; elapsed += 40) {
    for (const line of text(elapsed, 120, 30)) {
      for (const char of line) if (char.codePointAt(0)! > 127) seen.add(char);
    }
  }
  for (const char of seen) {
    assert.ok(safe.has(char), `U+${char.codePointAt(0)!.toString(16).toUpperCase()} (${char}) is not cleared for use`);
  }
});

test("the splash is an overlay covering the viewport, never inline", async () => {
  const { ctx, ui } = fakeContext(() => true);
  const running = runSetupSplash(ctx, { durationMs: 60_000, tickMs: 1_000 });
  ui.component?.handleInput("\r");
  await running;
  assert.equal(ui.options?.overlay, true, "an inline splash overflows the transcript and scrolls the terminal");
  assert.deepEqual(ui.options?.overlayOptions, { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" });
});

test("no splash outside TUI mode", async () => {
  let asked = false;
  const ctx = {
    hasUI: false,
    mode: "print",
    ui: { custom: () => ((asked = true), Promise.resolve(false)) },
  } as unknown as ExtensionContext;
  await runSetupSplash(ctx, { durationMs: 10, tickMs: 5 });
  assert.equal(asked, false);
});
