/**
 * /effort: see and change how hard the model thinks.
 *
 * pi has /thinking, but its name is easy to miss and it neither lists the levels nor says
 * what they mean. /effort opens a pick list of the levels the current model supports, or
 * sets one directly (`/effort high`). A level you pick sticks for the session; token-saver
 * stops lowering it for short prompts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

export const MEANINGS: Record<Level, string> = {
  off: "no reasoning, fastest and cheapest",
  minimal: "a quick check; good for simple edits",
  low: "light reasoning",
  medium: "balanced; a good default",
  high: "careful; for hard bugs and design",
  xhigh: "very deep; slower and costs more",
  max: "the most thinking the model allows",
};

type ModelLike = { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, unknown>> };

/** The levels a model accepts: all of them if it reasons, minus any it maps to null. */
export function supportedLevels(model: ModelLike | undefined): Level[] {
  if (!model?.reasoning) return ["off"];
  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    // The two top levels exist only when the model maps them explicitly.
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** "● medium · balanced; a good default": one pick-list row. */
export function levelLabel(level: Level, current: string): string {
  return `${level === current ? "●" : "○"} ${level} · ${MEANINGS[level]}`;
}

/** Reads `/effort high`: the level it names, or undefined. */
export function parseLevel(args: string): Level | undefined {
  const word = args.trim().toLowerCase();
  return LEVELS.find((level) => level === word);
}

export default function effort(pi: ExtensionAPI) {
  pi.registerCommand("effort", {
    description: "Show or set the reasoning effort: off, minimal, low, medium, high, xhigh or max",
    getArgumentCompletions: (prefix) =>
      LEVELS.filter((level) => level.startsWith(prefix.trim().toLowerCase())).map((level) => ({
        value: level,
        label: level,
        description: MEANINGS[level],
      })),
    handler: async (args, ctx) => {
      const model = ctx.model;
      const available = supportedLevels(model);
      const name = model?.name ?? model?.id ?? "This model";
      if (available.length === 1) {
        ctx.ui.notify(`${name} has no adjustable reasoning, so effort stays ${available[0]}.`, "info");
        return;
      }
      const current = pi.getThinkingLevel();
      let chosen = parseLevel(args);
      if (args.trim() && !chosen) {
        ctx.ui.notify(`Unknown effort "${args.trim()}". Use one of: ${available.join(", ")}.`, "warning");
        return;
      }
      if (chosen && !available.includes(chosen)) {
        ctx.ui.notify(`${name} doesn't support "${chosen}". Use one of: ${available.join(", ")}.`, "warning");
        return;
      }
      if (!chosen) {
        const labels = available.map((level) => levelLabel(level, current));
        const picked = await ctx.ui.select(`Reasoning effort for ${name}`, labels);
        if (!picked) return;
        chosen = available[labels.indexOf(picked)];
      }
      if (!chosen) return;
      pi.setThinkingLevel(chosen);
      ctx.ui.notify(`Reasoning effort: ${pi.getThinkingLevel()} for the rest of this session.`, "info");
    },
  });
}
