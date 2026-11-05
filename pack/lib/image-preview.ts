/**
 * Image helpers for attachments: spotting image paths in text, decoding, and drawing a
 * picture in the terminal with half-block characters.
 *
 * pi-tui can only draw real inline images in Kitty, iTerm2 and Warp. Windows Terminal is
 * none of those, so previews are drawn from "▀" cells instead: the top pixel is the
 * foreground color and the bottom pixel the background, which gives two pixels per cell in
 * any truecolor terminal. It is coarse but recognizable, and it works everywhere.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

export type Found = { start: number; end: number; path: string };

const EXT = "png|jpe?g|gif|webp";
/** A quoted path, or an absolute one: `C:\x.png`, `\\host\x.png`, `/x.png`, `~/x.png`. */
const PATH_PATTERN = new RegExp(
  `"([^"\\n]+\\.(?:${EXT}))"|((?:[A-Za-z]:[\\\\/]|\\\\\\\\|/|~[\\\\/])[^\\s"'<>|*?\\n]*\\.(?:${EXT}))(?![\\w.])`,
  "gi",
);

/** Image paths in a piece of text, in order. */
export function findImagePaths(text: string): Found[] {
  return [...text.matchAll(PATH_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    path: match[1] ?? match[2],
  }));
}

export function expandHome(path: string): string {
  return path.startsWith("~/") || path.startsWith("~\\") ? resolve(homedir(), path.slice(2)) : path;
}

export function isImageFile(path: string): boolean {
  try {
    return statSync(expandHome(path)).isFile();
  } catch {
    return false;
  }
}

export function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pixel size that fits `maxCols` x `maxRows` terminal cells, keeping the aspect ratio.
 * A cell is one pixel wide and two tall. `maxScale` stops tiny images from blowing up.
 */
export function fitSize(width: number, height: number, maxCols: number, maxRows: number, maxScale = 1): { w: number; h: number } {
  const scale = Math.min(maxCols / width, (maxRows * 2) / height, maxScale);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(2, Math.round((height * scale) / 2) * 2);
  return { w, h };
}

const BACKDROP = [11, 11, 11];

function channel(rgba: Uint8Array, at: number): [number, number, number] {
  const alpha = rgba[at + 3] / 255;
  return [0, 1, 2].map((i) => Math.round(rgba[at + i] * alpha + BACKDROP[i] * (1 - alpha))) as [number, number, number];
}

/** RGBA pixels to terminal rows of colored half-blocks. */
export function renderPixels(rgba: Uint8Array, width: number, height: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let row = "";
    let last = "";
    for (let x = 0; x < width; x++) {
      const [r, g, b] = channel(rgba, (y * width + x) * 4);
      const [r2, g2, b2] = y + 1 < height ? channel(rgba, ((y + 1) * width + x) * 4) : [r, g, b];
      const code = `\x1b[38;2;${r};${g};${b}m\x1b[48;2;${r2};${g2};${b2}m`;
      row += (code === last ? "" : code) + "▀";
      last = code;
    }
    rows.push(`${row}\x1b[0m`);
  }
  return rows;
}

type Photon = typeof import("@silvia-odwyer/photon-node");
type PhotonImage = import("@silvia-odwyer/photon-node").PhotonImage;

let photon: Photon | null | undefined;
/** photon-node is a dependency of pi; without it previews are skipped, not fatal. */
function loadPhoton(): Photon | null {
  if (photon === undefined) {
    try {
      photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as Photon;
    } catch {
      photon = null;
    }
  }
  return photon;
}

/** A decoded picture that can be drawn at any size. */
export class Picture {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly name: string;
  private image: PhotonImage;
  private lib: Photon;
  private cache = new Map<string, string[]>();

  private constructor(lib: Photon, image: PhotonImage, bytes: number, name: string) {
    this.lib = lib;
    this.image = image;
    this.width = image.get_width();
    this.height = image.get_height();
    this.bytes = bytes;
    this.name = name;
  }

  /** Decodes the file, or undefined when it is not a readable image. */
  static open(path: string): Picture | undefined {
    const lib = loadPhoton();
    if (!lib) return undefined;
    try {
      const file = expandHome(path);
      const data = readFileSync(file);
      return new Picture(lib, lib.PhotonImage.new_from_byteslice(new Uint8Array(data)), data.length, basename(file));
    } catch {
      return undefined;
    }
  }

  /** Terminal rows (each one string) for an image fitted to the given cells. */
  render(maxCols: number, maxRows: number, maxScale = 1): string[] {
    const key = `${maxCols}x${maxRows}x${maxScale}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const { w, h } = fitSize(this.width, this.height, maxCols, maxRows, maxScale);
    const small = this.lib.resize(this.image, w, h, this.lib.SamplingFilter.Lanczos3);
    try {
      const rows = renderPixels(small.get_raw_pixels(), w, h);
      this.cache.set(key, rows);
      return rows;
    } finally {
      small.free();
    }
  }

  free(): void {
    this.image.free();
    this.cache.clear();
  }
}

/** Opens the file in the system's image viewer, where it shows at full resolution. */
export function openExternally(path: string): void {
  const file = expandHome(path);
  // explorer/open/xdg-open take the path as an argument, so no shell ever parses it.
  const [command, args]: [string, string[]] = process.platform === "win32" ? ["explorer.exe", [file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

const MAX_SIDE = 2000;
const MAX_BYTES = 4 * 1024 * 1024;

/** The file as the model should receive it: shrunk when it is very large. */
export function readForModel(path: string): { data: string; mimeType: string } {
  const file = expandHome(path);
  const raw = readFileSync(file);
  const mimeType = mimeFor(file);
  const lib = loadPhoton();
  if (!lib || raw.length <= MAX_BYTES) return { data: raw.toString("base64"), mimeType };
  const image = lib.PhotonImage.new_from_byteslice(new Uint8Array(raw));
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(image.get_width(), image.get_height()));
    const shrunk = scale < 1 ? lib.resize(image, Math.round(image.get_width() * scale), Math.round(image.get_height() * scale), lib.SamplingFilter.Lanczos3) : image;
    try {
      return { data: Buffer.from(shrunk.get_bytes_jpeg(85)).toString("base64"), mimeType: "image/jpeg" };
    } finally {
      if (shrunk !== image) shrunk.free();
    }
  } finally {
    image.free();
  }
}
