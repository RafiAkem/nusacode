/**
 * A QR code as terminal lines, drawn like omp's: black modules on a light panel, two rows of
 * modules per text line using "▀" with explicit colors. The explicit light background keeps
 * it scannable on dark terminals, where an inverted code often is not.
 */
import { encode } from "uqr";

const LIGHT = "\x1b[38;2;208;208;208m";
const LIGHT_BG = "\x1b[48;2;208;208;208m";
const DARK = "\x1b[38;2;0;0;0m";
const DARK_BG = "\x1b[48;2;0;0;0m";
const RESET = "\x1b[0m";
const QUIET = 3; // modules of blank border; the spec says 4, scanners accept 2 or more

/** The matrix with its quiet zone, true where a module is dark. */
export function qrMatrix(text: string): boolean[][] {
  const { data, size } = encode(text, { ecc: "M", border: 0 });
  const width = size + QUIET * 2;
  const rows = Array.from({ length: width }, () => new Array<boolean>(width).fill(false));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rows[y + QUIET][x + QUIET] = data[y][x];
  return rows;
}

/** Terminal lines for the code; each is as wide as the code and ends with a reset. */
export function qrLines(text: string): string[] {
  const matrix = qrMatrix(text);
  const lines: string[] = [];
  for (let y = 0; y < matrix.length; y += 2) {
    let line = "";
    for (let x = 0; x < matrix[y].length; x++) {
      const top = matrix[y][x];
      const bottom = y + 1 < matrix.length ? matrix[y + 1][x] : false;
      line += `${top ? DARK : LIGHT}${bottom ? DARK_BG : LIGHT_BG}▀`;
    }
    lines.push(line + RESET);
  }
  return lines;
}
