/**
 * Clickable links everywhere. See ../lib/linkify.ts.
 * Set NUSACODE_NO_LINKS=1 to switch it off.
 */
import { getCapabilities } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installLinkifier } from "../lib/linkify.ts";

export default function links(pi: ExtensionAPI) {
  if (process.env.NUSACODE_NO_LINKS === "1") return;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // The widget exists only to be handed the TUI; it draws nothing.
    ctx.ui.setWidget(
      "links",
      (tui) => {
        installLinkifier(tui, () => getCapabilities().hyperlinks);
        return { render: () => [], invalidate() {} };
      },
      { placement: "belowEditor" },
    );
  });
}
