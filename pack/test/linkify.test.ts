import { test } from "node:test";
import assert from "node:assert/strict";
import { asLink, installLinkifier, linkifyLine, trimUrl } from "../lib/linkify.ts";

const link = (url: string) => asLink(url, url);

test("asLink is an underlined OSC 8 hyperlink", () => {
  assert.equal(asLink("docs", "https://a.dev"), "\x1b[4m\x1b]8;;https://a.dev\x1b\\docs\x1b]8;;\x1b\\\x1b[24m");
});

test("trimUrl drops sentence punctuation but keeps balanced brackets", () => {
  assert.equal(trimUrl("https://a.dev/x."), "https://a.dev/x");
  assert.equal(trimUrl("https://a.dev/x),"), "https://a.dev/x");
  assert.equal(trimUrl("https://en.wikipedia.org/wiki/Pi_(math)"), "https://en.wikipedia.org/wiki/Pi_(math)");
  assert.equal(trimUrl("https://a.dev/?q=1&b=2!"), "https://a.dev/?q=1&b=2");
});

test("a bare URL becomes an underlined hyperlink", () => {
  assert.equal(linkifyLine("see https://nusagate.com/docs now", 80), `see ${link("https://nusagate.com/docs")} now`);
});

test("localhost and address links work, with the token query kept whole", () => {
  const url = "http://127.0.0.1:7842/?token=abc_DEF-123";
  assert.equal(linkifyLine(url, 100), link(url));
  assert.equal(linkifyLine("http://localhost:3000/", 100), link("http://localhost:3000/"));
});

test("several URLs on one line, with the trailing punctuation left outside the link", () => {
  assert.equal(linkifyLine("a https://a.dev, b https://b.dev.", 100), `a ${link("https://a.dev")}, b ${link("https://b.dev")}.`);
});

test("colored text around a URL keeps its codes", () => {
  assert.equal(linkifyLine("\x1b[32mhttps://a.dev/x\x1b[0m", 100), `\x1b[32m${link("https://a.dev/x")}\x1b[0m`);
});

test("lines with an existing hyperlink, or no real URL, are left alone", () => {
  const existing = "\x1b]8;;https://a.dev\x1b\\docs\x1b]8;;\x1b\\ and https://b.dev";
  assert.equal(linkifyLine(existing, 80), existing);
  assert.equal(linkifyLine("no links here, just http as a word", 80), "no links here, just http as a word");
  assert.equal(linkifyLine("see http:// and https://x", 80), "see http:// and https://x");
});

test("a URL that runs to the screen edge is left to the terminal, since it probably wrapped", () => {
  const long = "https://example.com/" + "a".repeat(20);
  assert.equal(linkifyLine(long, long.length), long);
  assert.equal(linkifyLine(long, long.length + 10), link(long));
});

class Base {
  applyLineResets(lines: string[]): string[] {
    return lines.map((line) => `${line}|reset`);
  }
}
class Screen extends Base {
  terminal = { columns: 80 };
}

test("the linkifier wraps the TUI's final step once, for every subclass", () => {
  let on = true;
  installLinkifier(new Screen(), () => on);
  installLinkifier(new Screen(), () => on); // a second install changes nothing
  assert.deepEqual(new Screen().applyLineResets(["go to https://a.dev"]), [`go to ${link("https://a.dev")}|reset`]);
  on = false;
  assert.deepEqual(new Screen().applyLineResets(["go to https://a.dev"]), ["go to https://a.dev|reset"]);
});

test("a tui without the expected method is ignored", () => {
  assert.doesNotThrow(() => installLinkifier({}, () => true));
});
