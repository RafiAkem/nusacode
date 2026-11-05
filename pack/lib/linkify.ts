/**
 * Makes every web address on screen clickable, wherever it came from: assistant text, tool
 * output, notifications, errors. pi already links markdown links; this covers the bare URLs
 * it leaves as plain text.
 *
 * The link is an OSC 8 hyperlink with an underline so it looks clickable. Terminals that
 * support it (Windows Terminal, iTerm2, Kitty, WezTerm...) open it on click or ctrl+click.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

const URL_PATTERN = /https?:\/\/[^\s<>"'`\x1b\x07]+/g;
/** An OSC 8 link that is already open (one with a non-empty target). */
const OPEN_LINK = /\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]/;
/** Something that looks like a real address: a dotted host, localhost, or an IP. */
const REAL_HOST = /^https?:\/\/(?:[^/\s]+\.[^/\s]+|localhost|\d)/;

const ESC = "\x1b";
const OSC8_END = `${ESC}]8;;${ESC}\\`;

/** Drops punctuation that belongs to the sentence, not the address. */
export function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    const body = url.slice(0, end);
    const count = (char: string) => body.split(char).length - 1;
    if (".,;:!?'\"".includes(last)) end--;
    else if (last === ")" && count("(") < count(")")) end--;
    else if (last === "]" && count("[") < count("]")) end--;
    else break;
  }
  return url.slice(0, end);
}

/** The text as an underlined, clickable link to `url`. */
export function asLink(text: string, url: string): string {
  return `${ESC}[4m${ESC}]8;;${url}${ESC}\\${text}${OSC8_END}${ESC}[24m`;
}

/** One screen line with its bare URLs turned into links. */
export function linkifyLine(line: string, columns: number): string {
  if (!line.includes("http")) return line;
  if (OPEN_LINK.test(line)) return line; // pi already linked something here; don't nest
  return line.replace(URL_PATTERN, (match: string, offset: number) => {
    const url = trimUrl(match);
    if (!REAL_HOST.test(url)) return match;
    // A URL that runs to the edge of the screen was probably wrapped, and a link to the
    // first half would open the wrong page. Leave those to the terminal.
    const after = line.slice(offset + url.length);
    if (visibleWidth(after) === 0 && visibleWidth(line) >= columns - 1) return match;
    return asLink(url, url) + match.slice(url.length);
  });
}

const INSTALLED = Symbol.for("nusacode.linkify");

type LineRenderer = { applyLineResets(lines: string[]): string[]; terminal?: { columns?: number } };

/**
 * Wraps the TUI's last step before output so every line passes through linkifyLine.
 * pi-tui does not export its TUI class at runtime, so this finds the class from an instance.
 */
export function installLinkifier(tui: object, enabled: () => boolean): void {
  let owner: object | null = Object.getPrototypeOf(tui);
  while (owner && !Object.hasOwn(owner, "applyLineResets")) owner = Object.getPrototypeOf(owner);
  if (!owner || (owner as Record<symbol, unknown>)[INSTALLED]) return;
  const original = (owner as LineRenderer).applyLineResets;
  (owner as LineRenderer).applyLineResets = function (this: LineRenderer, lines: string[]) {
    if (!enabled()) return original.call(this, lines);
    const columns = this.terminal?.columns ?? 80;
    return original.call(this, lines.map((line) => linkifyLine(line, columns)));
  };
  (owner as Record<symbol, unknown>)[INSTALLED] = true;
}
