/**
 * Image attachments.
 *
 * Pasting an image (or a copied image file) puts its path in the prompt box. This turns the
 * path into an `[Image #1]` token, shows a thumbnail strip above the box, and attaches the
 * real image when the prompt is sent, so the model sees pixels instead of a path.
 *
 * Enlarge a thumbnail with `alt+i` (press again for the next one, then to close), or by
 * hovering it when the terminal reports mouse movement. Delete the token to detach.
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { findImagePaths, formatBytes, isImageFile, mimeFor, openExternally, Picture, readForModel } from "../lib/image-preview.ts";
import { messages } from "../lib/i18n.ts";

const t = messages(
  {
    enlargedHint: "{key} next · {open} open full size · esc close",
    stripHint: "{key} to enlarge · {open} open full size",
    stripHintMore: "+{more} more · {key} to enlarge · {open} open full size",
    noPreviewLabel: "#{id} no preview",
    title: "Image #{id} · {name} · {size}",
    titleSized: "Image #{id} · {name} · {width}×{height} · {size}",
    noPreview: "(no preview for this file)",
    openShortcut: "Open the attached image in your image viewer at full size",
    enlargeShortcut: "Enlarge the attached images",
    noVision: "{model} can't see images, so only your text was sent. Switch model with /model: the ones that can are marked (vision).",
    readFailed: "Could not read {path}, so it was not attached.",
  },
  {
    enlargedHint: "{key} berikutnya · {open} buka ukuran penuh · esc tutup",
    stripHint: "{key} untuk perbesar · {open} buka ukuran penuh",
    stripHintMore: "+{more} lagi · {key} untuk perbesar · {open} buka ukuran penuh",
    noPreviewLabel: "#{id} tak terbaca",
    title: "Gambar #{id} · {name} · {size}",
    titleSized: "Gambar #{id} · {name} · {width}×{height} · {size}",
    noPreview: "(tidak ada pratinjau untuk file ini)",
    openShortcut: "Buka gambar yang dilampirkan di penampil gambar dalam ukuran penuh",
    enlargeShortcut: "Perbesar gambar yang dilampirkan",
    noVision: "{model} tidak bisa melihat gambar, jadi hanya teks kamu yang dikirim. Ganti model dengan /model: model yang bisa ditandai (vision).",
    readFailed: "Tidak bisa membaca {path}, jadi file ini tidak dilampirkan.",
  },
);

export const TOKEN = /\[Image #(\d+)\]/g;
const THUMB_COLS = 16;
const THUMB_ROWS = 4;
const GAP = 2;
const OPEN_KEY = "alt+o";

/** The enlarged view fills the terminal width and most of its height. */
function bigSize(width: number): { cols: number; rows: number } {
  const rows = process.stdout.rows ?? 40;
  return { cols: Math.max(20, width - 1), rows: Math.min(50, Math.max(12, rows - 10)) };
}

export type Attachment = { id: number; path: string; picture: Picture | null };

/** What the strip is showing: the thumbnails, or one image enlarged. */
export type StripView = { items: { id: number; label: string; thumb: string[] }[]; enlarged: { title: string; rows: string[] } | null };

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** The strip as terminal lines. Pure so it can be tested without a terminal. */
export function stripLines(view: StripView, width: number, theme: Pick<Theme, "fg" | "bold">, key: string): string[] {
  if (view.items.length === 0) return [];
  if (view.enlarged) {
    return [
      truncateToWidth(`${theme.fg("accent", theme.bold(view.enlarged.title))}  ${theme.fg("dim", t("enlargedHint", { key, open: OPEN_KEY }))}`, width, "…"),
      ...view.enlarged.rows.map((row) => truncateToWidth(row, width, "")),
    ];
  }
  const slot = THUMB_COLS + GAP;
  const fit = Math.max(1, Math.floor((width + GAP) / slot));
  const shown = view.items.slice(0, fit);
  const lines: string[] = [];
  for (let r = 0; r < THUMB_ROWS; r++) {
    lines.push(shown.map((item) => pad(item.thumb[r] ?? "", THUMB_COLS)).join(" ".repeat(GAP)));
  }
  lines.push(shown.map((item) => theme.fg("dim", pad(truncateToWidth(item.label, THUMB_COLS, "…"), THUMB_COLS))).join(" ".repeat(GAP)));
  const more = view.items.length - shown.length;
  lines.push(theme.fg("dim", more > 0 ? t("stripHintMore", { more, key, open: OPEN_KEY }) : t("stripHint", { key, open: OPEN_KEY })));
  return lines.map((line) => truncateToWidth(line, width, ""));
}

class Strip implements Component {
  private tui: TUI;
  private theme: Theme;
  private state: State;
  constructor(tui: TUI, theme: Theme, state: State) {
    this.tui = tui;
    this.theme = theme;
    this.state = state;
    state.onChange = () => this.tui.requestRender();
  }
  render(width: number): string[] {
    return stripLines(this.state.view(width), width, this.theme, this.state.key);
  }
  handleMouse(event: { type: string; x: number; y: number }): { handled?: boolean; render?: boolean } | undefined {
    // Only arrives when the terminal reports mouse movement; alt+i always works.
    const slot = THUMB_COLS + GAP;
    const over = event.y < THUMB_ROWS ? this.state.present()[Math.floor(event.x / slot)] : undefined;
    if (event.type === "move") {
      this.state.enlarge(over?.id ?? null);
      return { handled: true, render: true };
    }
    if (event.type === "click" && over) {
      this.state.enlarge(this.state.enlargedId === over.id ? null : over.id);
      return { handled: true, render: true };
    }
    return undefined;
  }
  invalidate(): void {}
}

class State {
  attachments = new Map<number, Attachment>();
  enlargedId: number | null = null;
  onChange: () => void = () => {};
  key = "alt+i";
  private next = 1;
  private editorText = "";
  private lastText = "";

  /**
   * Backspace eats a token one character at a time, so `[Image #1]` becomes `[Image #1`.
   * When the box holds the front of a token that was whole a moment ago, drop the rest of it.
   */
  collapseBrokenTokens(text: string): string {
    let result = text;
    for (const match of this.lastText.matchAll(TOKEN)) {
      const token = match[0];
      if (result.includes(token)) continue;
      const head = this.lastText.slice(0, match.index);
      if (!result.startsWith(head)) continue;
      const rest = result.slice(head.length);
      for (let length = token.length - 1; length >= 1; length--) {
        if (rest.startsWith(token.slice(0, length))) {
          result = head + rest.slice(length);
          break;
        }
      }
    }
    return result;
  }

  remember(text: string): void {
    this.lastText = text;
  }

  /** Attaches a file and returns its token text. */
  attach(path: string): string {
    for (const existing of this.attachments.values()) if (existing.path === path) return `[Image #${existing.id}]`;
    const attachment: Attachment = { id: this.next++, path, picture: Picture.open(path) ?? null };
    this.attachments.set(attachment.id, attachment);
    this.onChange();
    return `[Image #${attachment.id}]`;
  }

  /** Attachments whose token is still in the prompt box. */
  present(): Attachment[] {
    const ids = new Set([...this.editorText.matchAll(TOKEN)].map((match) => Number(match[1])));
    return [...this.attachments.values()].filter((a) => ids.has(a.id));
  }

  /** Keeps only the attachments the prompt still mentions; frees the rest. */
  sync(text: string): void {
    this.editorText = text;
    const ids = new Set([...text.matchAll(TOKEN)].map((match) => Number(match[1])));
    for (const [id, attachment] of this.attachments) {
      if (ids.has(id)) continue;
      attachment.picture?.free();
      this.attachments.delete(id);
      if (this.enlargedId === id) this.enlargedId = null;
    }
    if (this.attachments.size === 0) this.next = 1;
  }

  clear(): void {
    this.sync("");
    this.enlargedId = null;
    this.onChange();
  }

  enlarge(id: number | null): void {
    if (this.enlargedId === id) return;
    this.enlargedId = id;
    this.onChange();
  }

  /** alt+i: first image, then each next one, then closed. */
  cycle(): void {
    const ids = this.present().map((a) => a.id);
    if (ids.length === 0) return;
    const at = this.enlargedId === null ? -1 : ids.indexOf(this.enlargedId);
    this.enlarge(at + 1 < ids.length ? ids[at + 1] : null);
  }

  view(width: number): StripView {
    const present = this.present();
    const items = present.map((a) => ({
      id: a.id,
      label: a.picture ? `#${a.id} ${a.picture.width}×${a.picture.height}` : t("noPreviewLabel", { id: a.id }),
      thumb: a.picture ? a.picture.render(THUMB_COLS, THUMB_ROWS) : [],
    }));
    const big = present.find((a) => a.id === this.enlargedId);
    return {
      items,
      enlarged: big
        ? {
            title: big.picture
              ? t("titleSized", { id: big.id, name: big.picture.name, width: big.picture.width, height: big.picture.height, size: formatBytes(big.picture.bytes) })
              : t("title", { id: big.id, name: big.path, size: formatBytes(0) }),
            rows: big.picture ? big.picture.render(bigSize(width).cols, bigSize(width).rows, 4) : [t("noPreview")],
          }
        : null,
    };
  }
}

export default function images(pi: ExtensionAPI) {
  const state = new State();
  let timer: ReturnType<typeof setInterval> | null = null;
  let offInput: (() => void) | null = null;

  /** Swap any image path in the box for a token, and drop attachments the box no longer mentions. */
  function tick(ctx: ExtensionContext): void {
    const text = ctx.ui.getEditorText();
    let next = state.collapseBrokenTokens(text);
    for (const found of findImagePaths(text).reverse()) {
      if (!isImageFile(found.path)) continue;
      next = next.slice(0, found.start) + state.attach(found.path) + next.slice(found.end);
    }
    if (next !== text) ctx.ui.setEditorText(next);
    state.sync(next);
    state.remember(next);
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state.clear();
    ctx.ui.setWidget("images", (tui, theme) => new Strip(tui, theme, state), { placement: "aboveEditor" });
    if (timer) clearInterval(timer);
    timer = setInterval(() => tick(ctx), 250);
    timer.unref();
    offInput?.();
    offInput = ctx.ui.onTerminalInput((data) => {
      // After a backspace, tidy a half-deleted token right away instead of at the next tick.
      if (data === "" || data === "") setTimeout(() => tick(ctx), 0);
      // Esc closes the big preview; otherwise it keeps its usual job.
      if (data === "\x1b" && state.enlargedId !== null) {
        state.enlarge(null);
        return { consume: true };
      }
      return undefined;
    });
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = null;
    offInput?.();
    offInput = null;
    state.clear();
  });

  pi.registerShortcut(OPEN_KEY, {
    description: t("openShortcut"),
    handler: () => {
      const shown = state.present().find((a) => a.id === state.enlargedId) ?? state.present()[0];
      if (shown) openExternally(shown.path);
    },
  });
  pi.registerShortcut("alt+i", { description: t("enlargeShortcut"), handler: () => state.cycle() });

  pi.on("input", (event, ctx) => {
    // Paths typed or pasted just before Enter have not been swapped for tokens yet.
    let text = event.text;
    for (const found of findImagePaths(text).reverse()) {
      if (isImageFile(found.path)) text = text.slice(0, found.start) + state.attach(found.path) + text.slice(found.end);
    }
    const ids = [...new Set([...text.matchAll(TOKEN)].map((match) => Number(match[1])))];
    const files = ids.flatMap((id) => state.attachments.get(id) ?? []);
    if (files.length === 0) return { action: "continue" as const };
    if (ctx.model && !ctx.model.input.includes("image")) {
      ctx.ui.notify(t("noVision", { model: ctx.model.name ?? ctx.model.id }), "warning");
      state.clear();
      return { action: "transform" as const, text, images: event.images };
    }
    const attached = files.flatMap((file) => {
      try {
        const { data, mimeType } = readForModel(file.path);
        return [{ type: "image" as const, data, mimeType: mimeType || mimeFor(file.path) }];
      } catch {
        ctx.ui.notify(t("readFailed", { path: file.path }), "warning");
        return [];
      }
    });
    state.clear();
    return { action: "transform" as const, text, images: [...(event.images ?? []), ...attached] };
  });
}
