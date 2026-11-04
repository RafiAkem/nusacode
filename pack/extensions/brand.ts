/**
 * NusaCode startup header.
 *
 * Replaces pi's logo line with the NusaCode wordmark in NusaGate's brand colors,
 * keeping the keybinding hints on the second line.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, keyText, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, mixColors, parseColor } from "@earendil-works/pi-tui";

/** nusagate.com accent colors, teal → purple → pink. */
const BRAND = ["#00e5cc", "#5ad8e6", "#9b4dff", "#ed4abf"];
const RESET = "\x1b[0m";

/** Horizontal brand gradient, one color per character. */
function wordmark(theme: Theme, text: string): string {
  const mode = theme.getColorMode();
  const stops = BRAND.map((hex) => parseColor(hex));
  const chars = [...text].map((char, i) => {
    const t = (i / Math.max(1, text.length - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    return foregroundAnsi(mixColors(stops[k], stops[k + 1], t - k, "srgb"), mode) + char;
  });
  return chars.join("") + RESET;
}

/** The two header lines: name, then key hints. */
export function headerLines(theme: Theme, hints: string): string[] {
  return [`${theme.bold(wordmark(theme, "NusaCode"))} ${theme.fg("dim", "nusagate")}`, hints];
}

export default function brand(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui, theme) => ({
      render: () =>
        headerLines(
          theme,
          [
            keyHint("app.interrupt", "interrupt"),
            rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
            rawKeyHint("/", "commands"),
            rawKeyHint("!", "bash"),
            keyHint("app.model.select", "model"),
          ].join(theme.fg("muted", " · ")),
        ),
      invalidate() {},
    }));
  });
}
