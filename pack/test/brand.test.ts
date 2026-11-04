import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { headerLines } from "../extensions/brand.ts";

const theme = {
  getColorMode: () => "truecolor",
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("header is the wordmark plus hints", () => {
  assert.deepEqual(headerLines(theme, "hints").map(plain), ["NusaCode nusagate", "hints"]);
});
