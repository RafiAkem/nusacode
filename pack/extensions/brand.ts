/**
 * NusaCode startup screen.
 *
 * Replaces pi's header with a welcome box: the NusaGate N in ASCII with a halo
 * of light orbiting it, key tips, the wallet summary published by meter.ts, and
 * the recent sessions for this directory.
 *
 * The box is the top of the transcript, and pi-tui clears the whole screen when
 * a line above the viewport changes. So it stops updating at the first agent
 * turn (running cost lives in the footer and `/usage`), and the halo only moves
 * while the logo is on screen.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Color, Component, TUI } from "@earendil-works/pi-tui";
import { foregroundAnsi, mixColors, parseColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextUsage, ExtensionAPI, ExtensionContext, SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import { keyText, SessionManager } from "@earendil-works/pi-coding-agent";
import { SUMMARY_CHANNEL, type SummaryRow } from "./meter.ts";

type ColorMode = ReturnType<Theme["getColorMode"]>;

const RESET = "\x1b[0m";

/** The N, by material: S silver face, G green face, g the lit inner edge. */
const LOGO = [
  "              GGGGG     ",
  "    SSSSS     GGGGGG    ",
  "   SSSSSSSS   GGGGGG    ",
  "   SSSSSSSSS  GGGGGG    ",
  "   SSSS SSSSS GGGGGG    ",
  "   SSgG  SSSSSSGGGGG    ",
  "   SSgG   SSSSSSGGGG    ",
  "   SSgG    SSSSSSSGG    ",
  "   SSgG     SSSSSSSS    ",
  "   SSgG      SSSSSSS    ",
  "   SSgG       SSSSSS    ",
];
const LOGO_WIDTH = LOGO[0].length;
const LOGO_HEIGHT = LOGO.length;
const GLYPHS: Record<string, string> = { S: "#", G: "%", g: "|" };

/** Each material's color at the top and bottom of the logo; the green is nusagate.com's accent. */
const SHADES: Record<string, [Color, Color]> = {
  S: [parseColor("#dfe8e3"), parseColor("#8fa39a")],
  G: [parseColor("#4ed899"), parseColor("#0c6e4a")],
  g: [parseColor("#5cdea2"), parseColor("#5cdea2")],
};
/** Halo brightness from faint to the comet's head; nusagate.com's accent and glow core. */
const HALO_DIM = parseColor("#1a7a55");
const HALO_MID = parseColor("#4ed899");
const HALO_CORE = parseColor("#ecfff6");

/** Halo ellipse, in cells. It rises to the right like the ring in the logo. */
const HALO = { centerX: 11.5, centerY: 5.5, radiusX: 11.5, radiusY: 1.4, tilt: 1.4 };
const HALO_SAMPLES = 360;
/** Fraction of the ring the comet's tail covers. */
const COMET_TAIL = 0.35;
const HALO_REST_INTENSITY = 0.5;
const HALO_PERIOD_MS = 2_400;
const HALO_TICK_MS = 66;
const HALO_RAMP = ".-~=*";

type HaloCell = { x: number; y: number; angle: number; front: boolean };

/** Cells on the ring. The near half passes in front of the N, the far half behind it. */
const HALO_CELLS: HaloCell[] = (() => {
  const cells = new Map<string, HaloCell>();
  for (let i = 0; i < HALO_SAMPLES; i++) {
    const angle = (i / HALO_SAMPLES) * 2 * Math.PI;
    const x = Math.round(HALO.centerX + HALO.radiusX * Math.cos(angle));
    const y = Math.round(HALO.centerY + HALO.radiusY * Math.sin(angle) - HALO.tilt * Math.cos(angle));
    const key = `${x},${y}`;
    if (x < 0 || x >= LOGO_WIDTH || y < 0 || y >= LOGO_HEIGHT || cells.has(key)) continue;
    cells.set(key, { x, y, angle, front: Math.sin(angle) > 0 });
  }
  return [...cells.values()];
})();

const MAX_BOX_WIDTH = 100;
const LEFT_COLUMN = 26;
const MIN_RIGHT_COLUMN = 20;
/** Fixed row counts, so async data arriving never changes the box height. */
const USAGE_SLOTS = 4;
const SESSION_SLOTS = 4;
const GREETING = "Selamat datang!";
/** Document row of the logo's first line: pi's spacer, top border, greeting and blanks. */
const LOGO_TOP_ROW = 5;
const MAX_ACTIVITY_WIDTH = 60;

const TIPS = [
  "/usage menampilkan biaya sesi, token, dan saldo.",
  "/topup menampilkan saldo dan link top up NusaGate.",
  "/resume melanjutkan sesi sebelumnya.",
  "Minta agent memakai tool task untuk mendelegasikan tugas ke subagent.",
  "Awali dengan !! untuk menjalankan bash tanpa mengirim hasilnya ke model.",
];

function readVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return String(manifest.version);
}

function haloCell(cell: HaloCell, phase: number | null): { glyph: string; color: Color } {
  let intensity = HALO_REST_INTENSITY;
  if (phase !== null) {
    const behindHead = (((phase - cell.angle / (2 * Math.PI)) % 1) + 1) % 1;
    intensity = 0.2 + 0.8 * Math.max(0, 1 - behindHead / COMET_TAIL) ** 2;
  }
  const color =
    intensity < 0.5
      ? mixColors(HALO_DIM, HALO_MID, intensity * 2, "srgb")
      : mixColors(HALO_MID, HALO_CORE, (intensity - 0.5) * 2, "srgb");
  const cos = Math.cos(cell.angle);
  const glyph =
    Math.abs(cos) > 0.985 ? (cos > 0 ? ")" : "(") : HALO_RAMP[Math.min(HALO_RAMP.length - 1, Math.floor(intensity * HALO_RAMP.length))];
  return { glyph, color };
}

/** The logo with the comet at `phase` in [0, 1), or the evenly lit ring when null. */
export function logoFrame(mode: ColorMode, phase: number | null = null): string[] {
  const grid = LOGO.map((line, y) =>
    [...line].map((material) => {
      if (material === " ") return { glyph: " ", color: null as Color | null };
      const [top, bottom] = SHADES[material];
      return { glyph: GLYPHS[material], color: mixColors(top, bottom, y / (LOGO_HEIGHT - 1), "srgb") as Color | null };
    }),
  );
  for (const cell of HALO_CELLS) {
    if (cell.front || grid[cell.y][cell.x].glyph === " ") grid[cell.y][cell.x] = haloCell(cell, phase);
  }
  return grid.map((row) => {
    let previous = "";
    const cells = row.map(({ glyph, color }) => {
      if (!color) return glyph;
      const ansi = foregroundAnsi(color, mode);
      const prefix = ansi === previous ? "" : ansi;
      previous = ansi;
      return prefix + glyph;
    });
    return cells.join("") + RESET;
  });
}

export function timeAgo(then: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} mnt lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return `${Math.floor(hours / 24)} hari lalu`;
}

/** One line for a session: its name, else its first prompt. */
export function sessionLabel(session: Pick<SessionInfo, "name" | "firstMessage" | "messageCount">): string {
  if (session.name) return session.name;
  return session.messageCount > 0 ? session.firstMessage.replace(/\s+/g, " ").trim() : "Tanpa judul";
}

export type WelcomeView = {
  version: string;
  model: string;
  provider: string;
  /** Key, then what it does. */
  tips: [string, string][];
  usage: SummaryRow[];
  sessions: { label: string; ago: string }[];
  tip: string;
};

function center(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return " ".repeat(left) + text;
}

function rightColumn(view: WelcomeView, width: number, theme: Theme): string[] {
  const heading = (text: string) => ` ${theme.bold(theme.fg("accent", text))}`;
  const separator = ` ${theme.fg("dim", "─".repeat(Math.max(0, width - 2)))}`;
  const slots = (lines: string[], count: number) => [...lines, ...Array<string>(count).fill("")].slice(0, count);

  const labelWidth = Math.max(0, ...view.usage.map((row) => row.label.length)) + 2;
  const usage = view.usage.map(
    (row) =>
      ` ${theme.fg("dim", row.label.padEnd(labelWidth))}${theme.fg(row.warn ? "warning" : "muted", row.value)}`,
  );

  const sessions = view.sessions.map((session) => {
    const suffix = ` (${session.ago})`;
    const budget = Math.max(1, width - 4 - visibleWidth(suffix));
    return `${theme.fg("dim", " • ")}${theme.fg("muted", truncateToWidth(session.label, budget, "…"))}${theme.fg("dim", suffix)}`;
  });

  return [
    heading("Tips"),
    ...view.tips.map(([key, text]) => ` ${theme.fg("dim", key)}${theme.fg("muted", ` ${text}`)}`),
    separator,
    heading("Pemakaian"),
    ...slots(usage.length > 0 ? usage : [` ${theme.fg("dim", "memuat...")}`], USAGE_SLOTS),
    separator,
    heading("Sesi terakhir"),
    ...slots(sessions.length > 0 ? sessions : [` ${theme.fg("dim", "Belum ada sesi")}`], SESSION_SLOTS),
  ];
}

/** The whole box plus the tip line beneath it. Below two-column width, only the left column shows. */
export function welcomeLines(view: WelcomeView, termWidth: number, theme: Theme, logo: string[]): string[] {
  const boxWidth = Math.min(MAX_BOX_WIDTH, termWidth - 2);
  if (boxWidth < 4) return [];
  const twoColumns = boxWidth - 3 - LEFT_COLUMN >= MIN_RIGHT_COLUMN;
  const leftWidth = twoColumns ? LEFT_COLUMN : boxWidth - 2;
  const rightWidth = twoColumns ? boxWidth - 3 - LEFT_COLUMN : 0;
  const border = (text: string) => theme.fg("dim", text);
  const fit = (text: string, width: number) => truncateToWidth(text, width, "…", true);

  const left = [
    "",
    center(theme.bold(GREETING), leftWidth),
    "",
    ...logo.map((line) => center(line, leftWidth)),
    "",
    center(theme.fg("muted", fit(view.model, leftWidth - 2).trimEnd()), leftWidth),
    center(theme.fg("dim", view.provider), leftWidth),
  ];
  const right = twoColumns ? rightColumn(view, rightWidth, theme) : [];

  const title = `${border("───")} ${theme.bold(theme.fg("accent", "NusaCode"))}${theme.fg("muted", ` v${view.version} `)}`;
  const titleFill = Math.max(0, boxWidth - 2 - visibleWidth(title));
  const lines = [`${border("╭")}${truncateToWidth(title, boxWidth - 2, "…")}${border(`${"─".repeat(titleFill)}╮`)}`];

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const cells = [fit(left[i] ?? "", leftWidth)];
    if (twoColumns) cells.push(fit(right[i] ?? "", rightWidth));
    lines.push(border("│") + cells.join(border("│")) + border("│"));
  }
  lines.push(
    border(twoColumns ? `╰${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}╯` : `╰${"─".repeat(leftWidth)}╯`),
  );

  if (view.tip) {
    const label = theme.fg("customMessageLabel", "Tip: ");
    lines.push(truncateToWidth(` ${theme.italic(label + theme.fg("muted", view.tip))}`, boxWidth, "…"));
  }
  return lines;
}

class WelcomeHeader implements Component {
  private animationStart: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frozen = false;
  private cache: { width: number; lines: string[] } | null = null;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private view: WelcomeView;

  constructor(tui: TUI, theme: Theme, view: WelcomeView) {
    this.tui = tui;
    this.theme = theme;
    this.view = view;
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Applies async data until the first agent turn; later changes are dropped. */
  update(patch: Partial<WelcomeView>): void {
    if (this.frozen) return;
    this.view = { ...this.view, ...patch };
    this.cache = null;
    this.tui.requestRender();
  }

  freeze(): void {
    this.frozen = true;
    this.stopHalo();
  }

  /** Orbits the halo until the first agent turn, or until the logo scrolls off. */
  playHalo(): void {
    if (this.logoScrolledOff()) return;
    this.animationStart = performance.now();
    this.timer = setInterval(() => {
      if (this.logoScrolledOff()) this.stopHalo();
      else this.tui.requestRender();
    }, HALO_TICK_MS);
    this.timer.unref();
  }

  /**
   * A logo above the viewport would turn every frame into a full-screen clear.
   * Checked per frame because notices can push the box up after the halo starts.
   */
  private logoScrolledOff(): boolean {
    const { columns, rows } = this.tui.terminal;
    return this.tui.render(columns).length - rows > LOGO_TOP_ROW;
  }

  private stopHalo(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.animationStart = null;
    this.cache = null;
    this.tui.requestRender();
  }

  private lines(width: number): string[] {
    const phase =
      this.animationStart === null ? null : ((performance.now() - this.animationStart) / HALO_PERIOD_MS) % 1;
    return welcomeLines(this.view, width, this.theme, logoFrame(this.theme.getColorMode(), phase));
  }

  render(width: number): string[] {
    if (this.animationStart !== null) return this.lines(width);
    if (this.cache?.width !== width) this.cache = { width, lines: this.lines(width) };
    return this.cache.lines;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export type StatusBarView = {
  model: string;
  /** Thinking level, for models that reason. */
  thinking?: string;
  folder: string;
  sessionName?: string;
  branch: string | null;
  context: ContextUsage | undefined;
  autoCompact: boolean;
  /** Extension statuses such as the rupiah meter. */
  statuses: string[];
};

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function contextText(context: ContextUsage, theme: Theme): string {
  const percent = context.percent ?? 0;
  const text = `${context.percent === null ? "?" : `${percent.toFixed(1)}%`}/${compactTokens(context.contextWindow)}`;
  if (percent > 90) return theme.fg("error", text);
  return percent > 70 ? theme.fg("warning", text) : theme.fg("muted", text);
}

/** One line: session on the left, statuses on the right. Statuses wrap below when both don't fit. */
export function statusBarLines(view: StatusBarView, width: number, theme: Theme): string[] {
  const model = view.thinking ? `${view.model} • ${view.thinking}` : view.model;
  const parts = [theme.fg("accent", `◆ ${model}`), theme.fg("text", view.folder)];
  if (view.sessionName) parts.push(theme.fg("muted", view.sessionName));
  if (view.branch) parts.push(theme.fg("success", view.branch));
  if (view.context) {
    const auto = view.autoCompact ? theme.fg("dim", " ⟲") : "";
    parts.push(contextText(view.context, theme) + auto);
  }
  const left = parts.join(theme.fg("dim", " · "));
  const right = theme.fg("dim", view.statuses.join(" "));
  if (!right) return [truncateToWidth(left, width, "…")];
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 2) return [left + " ".repeat(gap) + right];
  return [truncateToWidth(left, width, "…"), truncateToWidth(right, width, "…")];
}

function mountStatusBar(pi: ExtensionAPI, ctx: ExtensionContext): void {
  // getContextUsage scans the session and the footer renders every frame.
  // Every append moves the leaf, so it only changes with the leaf or the model.
  let cached: { key: string; usage: ContextUsage | undefined } | null = null;
  const contextUsage = () => {
    const key = `${ctx.sessionManager.getLeafId()}|${ctx.model?.provider}/${ctx.model?.id}`;
    if (cached?.key !== key) cached = { key, usage: ctx.getContextUsage() };
    return cached.usage;
  };
  ctx.ui.setFooter((_tui, theme, footerData) => ({
    render: (width) =>
      statusBarLines(
        {
          model: ctx.model?.name ?? "Belum ada model",
          thinking: ctx.model?.reasoning ? pi.getThinkingLevel() : undefined,
          folder: basename(ctx.cwd),
          sessionName: ctx.sessionManager.getSessionName(),
          branch: footerData.getGitBranch(),
          context: contextUsage(),
          autoCompact: pi.getSettings().compaction?.enabled !== false,
          statuses: [...footerData.getExtensionStatuses().entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text.replace(/\s+/g, " ").trim()),
        },
        width,
        theme,
      ),
    invalidate() {},
  }));
}

/** What the spinner says while a tool runs, e.g. "Membaca README.md". */
export function describeTool(name: string, args: unknown): string {
  const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string).replace(/\s+/g, " ").trim() : "");
  const full = text("path") || text("command") || text("pattern") || text("prompt");
  const target = full.length > MAX_ACTIVITY_WIDTH ? `${full.slice(0, MAX_ACTIVITY_WIDTH)}…` : full;
  const verbs: Record<string, string> = {
    read: "Membaca",
    write: "Menulis",
    edit: "Mengedit",
    bash: "Menjalankan",
    powershell: "Menjalankan",
    grep: "Mencari",
    find: "Mencari",
    ls: "Melihat",
    task: "Mendelegasikan",
  };
  const verb = verbs[name.toLowerCase()] ?? `Memakai ${name}`;
  return target ? `${verb} ${target}` : verb;
}

function keyTips(): [string, string][] {
  return [
    ["/", "untuk perintah · ! untuk bash"],
    [keyText("app.model.select"), "untuk ganti model"],
    [`${keyText("app.thinking.toggle")} · ${keyText("app.tools.expand")}`, "buka pikiran · output tool"],
    [`${keyText("app.interrupt")} · ${keyText("app.exit")}`, "untuk hentikan · keluar"],
  ];
}

async function recentSessions(ctx: ExtensionContext): Promise<WelcomeView["sessions"]> {
  const current = ctx.sessionManager.getSessionFile();
  const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
  const now = new Date();
  return sessions
    .filter((session) => session.path !== current)
    .slice(0, SESSION_SLOTS)
    .map((session) => ({ label: sessionLabel(session), ago: timeAgo(session.modified, now) }));
}

export default function brand(pi: ExtensionAPI) {
  let header: WelcomeHeader | null = null;
  // meter.ts may publish before this extension's session_start handler runs.
  let usage: SummaryRow[] = [];

  pi.events.on(SUMMARY_CHANNEL, (data) => {
    usage = (data as { rows: SummaryRow[] }).rows;
    header?.update({ usage });
  });

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    mountStatusBar(pi, ctx);
    ctx.ui.setHiddenThinkingLabel(`Berpikir (${keyText("app.thinking.toggle")} untuk membuka)`);
    const view: WelcomeView = {
      version: readVersion(),
      model: ctx.model?.name ?? "Belum ada model",
      provider: ctx.model?.provider ?? "",
      tips: keyTips(),
      usage,
      sessions: [],
      tip: TIPS[Math.floor(Math.random() * TIPS.length)],
    };
    const fresh = !ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
    let mounted: WelcomeHeader | null = null;
    ctx.ui.setHeader((tui, theme) => {
      mounted = new WelcomeHeader(tui, theme, view);
      if (event.reason === "startup" && fresh) mounted.playHalo();
      header = mounted;
      return mounted;
    });
    // Not awaited: session_start handlers block startup.
    void recentSessions(ctx).then(
      (sessions) => mounted?.update({ sessions }),
      () => {}, // The panel's "no sessions" line is an acceptable fallback.
    );
  });

  pi.on("model_select", (event) => {
    header?.update({ model: event.model.name, provider: event.model.provider });
  });

  pi.on("agent_start", () => {
    header?.freeze();
  });

  let runningTools = 0;
  pi.on("tool_execution_start", (event, ctx) => {
    runningTools += 1;
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage(describeTool(event.toolName, event.args));
  });
  pi.on("tool_execution_end", (_event, ctx) => {
    runningTools = Math.max(0, runningTools - 1);
    if (ctx.mode === "tui" && runningTools === 0) ctx.ui.setWorkingMessage();
  });
  pi.on("agent_end", (_event, ctx) => {
    runningTools = 0;
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  });
}
