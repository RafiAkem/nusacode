import { after, test } from "node:test";
import assert from "node:assert/strict";
import { renderOutro, runSetupOutro, SETUP_OUTRO_MS } from "../lib/outro.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// The scenes' timers are unref'd so they can't hold the CLI open. Without this, Node 22
// sees an empty event loop while a test awaits one and cancels the test.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]): string[] => lines.map((line) => line.replace(ANSI, ""));
const text = (elapsed: number, width = 100, height = 30): string[] => plain(renderOutro(width, height, elapsed));

/** The row holding the sweep bar: nothing but bar glyphs and padding. */
function sweepRow(lines: string[]): number {
  const index = lines.findIndex((line) => /^[\s=-]+$/.test(line) && /[=-]/.test(line));
  assert.ok(index >= 0, "the sweep bar is on screen");
  return index;
}

const filled = (line: string): number => (line.match(/=/g) ?? []).length;

test("an outro frame fills the requested box exactly", () => {
  for (const [width, height] of [
    [100, 30],
    [80, 24],
    [44, 16],
    [1, 1],
    [8, 3],
  ]) {
    const lines = renderOutro(width, height, 400);
    assert.equal(lines.length, height, `${width}x${height} rows`);
    for (const line of plain(lines)) assert.equal(line.length, width, `${width}x${height} columns`);
  }
});

test("it says what just happened", () => {
  const frame = text(800).join("\n");
  assert.match(frame, /Setup saved/);
  assert.match(frame, /NusaCode/);
  assert.match(frame, /handing off to the terminal/);
});

test("the sweep fills as the outro runs, and only the sweep row moves once the copy has landed", () => {
  const early = text(1_000);
  const later = text(1_100);
  const row = sweepRow(early);
  assert.equal(sweepRow(later), row, "the bar stays on its row");
  assert.ok(filled(later[row]!) > filled(early[row]!), "the bar fills up");

  // Everything except the sweep must be identical once the typing and the shine are
  // done, or the whole screen repaints every tick and the outro flickers.
  for (let y = 0; y < early.length; y++) {
    if (y === row) continue;
    assert.equal(later[y], early[y], `row ${y} must not change`);
  }
});

test("the sweep starts empty and ends full", () => {
  const first = text(0);
  assert.equal(filled(first[sweepRow(first)]!), 0, "nothing filled at the start");
  const last = text(SETUP_OUTRO_MS);
  const lastRow = last[sweepRow(last)]!;
  assert.ok(!/-/.test(lastRow), `no empty cells left, got ${lastRow.trim()}`);
});

test("the two message lines are bold, and bold is closed again", () => {
  const raw = renderOutro(100, 30, 1_000);
  const rows = plain(raw);
  const titleRow = rows.findIndex((line) => line.includes("Setup saved"));
  const subtitleRow = rows.findIndex((line) => line.includes("handing off"));
  const wordRow = rows.findIndex((line) => line.includes("NusaCode"));
  assert.ok(titleRow >= 0 && subtitleRow >= 0 && wordRow >= 0, "all three lines are on screen");
  assert.ok(raw[titleRow]!.includes("\x1b[1m"), "Setup saved is bold");
  assert.ok(raw[subtitleRow]!.includes("\x1b[1m"), "the line under it is bold too");
  assert.ok(raw[titleRow]!.includes("\x1b[22m"), "bold is switched off before the row ends");
  assert.ok(raw[subtitleRow]!.includes("\x1b[22m"), "bold is switched off before the row ends");
  // Bold must not leak onto the wordmark or the sweep.
  assert.ok(!raw[wordRow]!.includes("\x1b[1m"), "the wordmark stays regular");
});

test("every glyph is ASCII, so nothing renders wider than it measures", () => {
  for (let elapsed = 0; elapsed <= SETUP_OUTRO_MS; elapsed += 100) {
    for (const line of text(elapsed, 120, 30)) {
      for (const char of line) {
        assert.ok(char.codePointAt(0)! <= 127, `U+${char.codePointAt(0)!.toString(16)} is not ASCII`);
      }
    }
  }
});

type FakeUi = {
  renders: number;
  component: { render(width: number): string[]; handleInput(data: string): void } | null;
  options: { overlay?: boolean; overlayOptions?: Record<string, unknown> } | null;
};

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
            { terminal: { rows: 24, columns: 80 }, requestRender: () => void ui.renders++ },
            { getColorMode: () => "truecolor" },
            { matches },
            resolve,
          );
        }),
    },
  } as unknown as ExtensionContext;
  return { ctx, ui };
}

test("the outro is a full-viewport overlay, like the splash", async () => {
  const { ctx, ui } = fakeContext(() => true);
  const running = runSetupOutro(ctx, { durationMs: 60_000, tickMs: 1_000 });
  ui.component?.handleInput("\r");
  await running;
  assert.equal(ui.options?.overlay, true);
  assert.deepEqual(ui.options?.overlayOptions, { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" });
});

test("any key dismisses it, and it closes itself on time", async () => {
  const { ctx, ui } = fakeContext(() => true);
  const started = performance.now();
  const running = runSetupOutro(ctx, { durationMs: 60_000, tickMs: 1_000 });
  ui.component?.handleInput(" ");
  await running;
  assert.ok(performance.now() - started < 500, "space skipped it");

  const timed = fakeContext(() => false);
  const began = performance.now();
  await runSetupOutro(timed.ctx, { durationMs: 120, tickMs: 20 });
  const elapsed = performance.now() - began;
  assert.ok(elapsed >= 100 && elapsed < 2_000, `closed on its own, took ${elapsed}ms`);
});

test("no outro outside TUI mode", async () => {
  let asked = false;
  const ctx = {
    hasUI: false,
    mode: "print",
    ui: { custom: () => ((asked = true), Promise.resolve(false)) },
  } as unknown as ExtensionContext;
  await runSetupOutro(ctx, { durationMs: 10, tickMs: 5 });
  assert.equal(asked, false);
});
