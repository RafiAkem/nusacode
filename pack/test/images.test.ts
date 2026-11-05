import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { findImagePaths, fitSize, formatBytes, mimeFor, Picture, renderPixels } from "../lib/image-preview.ts";
import { stripLines, type StripView } from "../extensions/images.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("findImagePaths finds Windows, unix, home and quoted paths with their positions", () => {
  const text = String.raw`look at C:\Users\me\shot.png and /tmp/a.JPG, ~/pics/b.webp or "D:\my files\c.gif" please`;
  assert.deepEqual(
    findImagePaths(text).map((found) => found.path),
    [String.raw`C:\Users\me\shot.png`, "/tmp/a.JPG", "~/pics/b.webp", String.raw`D:\my files\c.gif`],
  );
  const first = findImagePaths(text)[0];
  assert.equal(text.slice(first.start, first.end), String.raw`C:\Users\me\shot.png`);
});

test("findImagePaths ignores other files and bare words", () => {
  assert.deepEqual(findImagePaths("see notes.png and C:\\x\\readme.md and image.png2"), []);
});

test("mimeFor and formatBytes", () => {
  assert.equal(mimeFor("a.JPG"), "image/jpeg");
  assert.equal(mimeFor("a.webp"), "image/webp");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("fitSize keeps the aspect ratio inside the cells and never upscales by default", () => {
  assert.deepEqual(fitSize(400, 200, 16, 4), { w: 16, h: 8 });
  assert.deepEqual(fitSize(100, 400, 16, 4), { w: 2, h: 8 });
  assert.deepEqual(fitSize(8, 8, 16, 4), { w: 8, h: 8 });
  assert.deepEqual(fitSize(8, 8, 100, 20, 4), { w: 32, h: 32 });
});

test("renderPixels draws two pixels per cell: top as foreground, bottom as background", () => {
  // One column, a red pixel over a blue one.
  const rows = renderPixels(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), 1, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0], "\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀\x1b[0m");
});

test("transparent pixels blend into the dark backdrop", () => {
  const rows = renderPixels(new Uint8Array([255, 255, 255, 0, 255, 255, 255, 0]), 1, 2);
  assert.ok(rows[0].includes("38;2;11;11;11"));
});

test("a real image decodes and draws at the requested size", () => {
  const picture = Picture.open(join(import.meta.dirname, "..", "..", "docs", "demo.gif"));
  assert.ok(picture, "docs/demo.gif should decode");
  assert.ok(picture.width > 0 && picture.height > 0);
  const rows = picture.render(16, 4);
  assert.ok(rows.length >= 1 && rows.length <= 4);
  assert.ok(rows.every((row) => plain(row).length <= 16));
  assert.equal(picture.render(16, 4), rows, "the second draw comes from the cache");
  picture.free();
});

test("a missing or non-image file does not decode", () => {
  assert.equal(Picture.open(join(import.meta.dirname, "no-such-file.png")), undefined);
  assert.equal(Picture.open(join(import.meta.dirname, "images.test.ts")), undefined);
});

const thumb = Array.from({ length: 4 }, () => "T".repeat(16));
const view = (over: Partial<StripView> = {}): StripView => ({
  items: [
    { id: 1, label: "#1 640×480", thumb },
    { id: 2, label: "#2 32×32", thumb },
  ],
  enlarged: null,
  ...over,
});

test("no attachments means no strip at all", () => {
  assert.deepEqual(stripLines(view({ items: [] }), 80, theme, "alt+i"), []);
});

test("thumbnails sit side by side with a label row and a hint", () => {
  const lines = stripLines(view(), 80, theme, "alt+i");
  assert.equal(lines.length, 6);
  assert.equal(lines[0], `${"T".repeat(16)}  ${"T".repeat(16)}`);
  assert.ok(lines[4].includes("#1 640×480") && lines[4].includes("#2 32×32"));
  assert.ok(lines[5].includes("alt+i to enlarge"));
});

test("thumbnails that do not fit are counted, not squeezed", () => {
  const lines = stripLines(view(), 20, theme, "alt+i");
  assert.equal(plain(lines[0]), "T".repeat(16));
  assert.ok(lines[5].includes("+1 more"));
});

test("an enlarged image replaces the thumbnails under a title", () => {
  const lines = stripLines(view({ enlarged: { title: "Image #2 · shot.png", rows: ["BIG1", "BIG2"] } }), 80, theme, "alt+i");
  assert.deepEqual(lines.slice(1), ["BIG1", "BIG2"]);
  assert.ok(lines[0].includes("Image #2 · shot.png") && lines[0].includes("esc close"));
});

type Handler = (event: any, ctx: any) => any;

/** The extension against a fake pi and a fake prompt box. */
function harness(model: { name: string; input: string[] } = { name: "Vision", input: ["text", "image"] }) {
  const handlers = new Map<string, Handler>();
  let shortcut: (() => void) | undefined;
  const box = { text: "" };
  const notes: string[] = [];
  let widget: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  const ctx = {
    mode: "tui",
    model,
    ui: {
      getEditorText: () => box.text,
      setEditorText: (text: string) => (box.text = text),
      setWidget: (_key: string, factory: typeof widget) => (widget = factory),
      onTerminalInput: () => () => {},
      notify: (text: string) => notes.push(text),
    },
  };
  return import("../extensions/images.ts").then(({ default: images }) => {
    images({
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerShortcut: (_key: string, options: { handler: () => void }) => (shortcut = options.handler),
    } as never);
    handlers.get("session_start")!({}, ctx);
    const strip = widget!({ requestRender() {} }, theme);
    return {
      box, notes, strip,
      submit: (text: string) => handlers.get("input")!({ text, source: "interactive" }, ctx),
      cycle: () => shortcut!(),
      end: () => handlers.get("session_shutdown")!({}, ctx),
    };
  });
}

const demo = join(import.meta.dirname, "..", "..", "docs", "demo.gif");

test("sending a prompt with an image path attaches the image and swaps in a token", async () => {
  const h = await harness();
  const result = await h.submit(`what is in ${demo}?`);
  assert.equal(result.action, "transform");
  assert.equal(result.text, "what is in [Image #1]?");
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mimeType, "image/gif");
  assert.ok(result.images[0].data.length > 100);
  h.end();
});

test("a prompt without images is left alone", async () => {
  const h = await harness();
  assert.deepEqual(await h.submit("just text"), { action: "continue" });
  h.end();
});

test("a text-only model gets a warning and no images", async () => {
  const h = await harness({ name: "Plain", input: ["text"] });
  const result = await h.submit(`see ${demo}`);
  assert.equal(result.images, undefined);
  assert.match(h.notes[0], /Plain can't see images/);
  h.end();
});

test("the strip shows a thumbnail while the token is in the box and enlarges with the shortcut", async () => {
  const h = await harness();
  const { default: images } = await import("../extensions/images.ts");
  assert.equal(typeof images, "function");
  h.box.text = `look at ${demo}`;
  // The extension's timer swaps the path for a token; drive it by submitting nothing and waiting a tick.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(h.box.text, "look at [Image #1]");
  const small = h.strip.render(100).map(plain);
  assert.ok(small.some((line) => line.includes("#1")) && small.some((line) => line.includes("alt+i to enlarge")));
  h.cycle();
  const big = h.strip.render(100).map(plain);
  assert.ok(big[0].includes("Image #1") && big.length > small.length);
  h.cycle();
  assert.equal(h.strip.render(100).length, small.length, "a second press closes it");
  h.box.text = "token deleted";
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(h.strip.render(100), [], "removing the token removes the thumbnail");
  h.end();
});
