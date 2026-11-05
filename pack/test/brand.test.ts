import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import brand, {
  describeTool,
  logoFrame,
  sessionLabel,
  statusBarLines,
  timeAgo,
  welcomeLines,
  type StatusBarView,
  type WelcomeView,
} from "../extensions/brand.ts";

const theme = {
  getColorMode: () => "truecolor",
  bold: (text: string) => text,
  italic: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const view: WelcomeView = {
  version: "1.2.3",
  model: "deepseek-v4.1-flash",
  provider: "nusagate",
  tips: [["/", "untuk perintah"]],
  usage: [{ label: "Saldo", value: "Rp 12.345" }],
  sessions: [{ label: "perbaiki bug meter", ago: "3 mnt lalu" }],
  tip: "/usage menampilkan biaya",
};

function render(overrides: Partial<WelcomeView> = {}, width = 120): string[] {
  return welcomeLines({ ...view, ...overrides }, width, theme, logoFrame("truecolor")).map(plain);
}

test("box shows version, model, tips, usage, sessions and the tip line", () => {
  const text = render().join("\n");
  for (const expected of ["NusaCode v1.2.3", "deepseek-v4.1-flash", "nusagate", "/ untuk perintah", "Pemakaian", "Saldo  Rp 12.345", "perbaiki bug meter (3 mnt lalu)", "Tip: /usage"]) {
    assert.ok(text.includes(expected), `missing: ${expected}\n${text}`);
  }
});

test("every box row is exactly the box width", () => {
  const box = render().slice(0, -1);
  assert.deepEqual([...new Set(box.map((line) => [...line].length))], [100]);
});

test("box height does not change when async data arrives", () => {
  const empty = render({ usage: [], sessions: [] });
  const full = render({
    usage: ["Saldo", "Pass", "Harga", "Hemat"].map((label) => ({ label, value: "x" })),
    sessions: Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, ago: "1 mnt lalu" })),
  });
  assert.equal(empty.length, full.length);
});

test("a long session label is cut before its age", () => {
  const line = render({ sessions: [{ label: "x".repeat(300), ago: "2 jam lalu" }] }).find((l) => l.includes("2 jam lalu"));
  assert.ok(line?.includes("… (2 jam lalu)"), line);
});

test("narrow terminals drop the right column and stay in bounds", () => {
  const lines = render({}, 40);
  assert.ok(!lines.join("\n").includes("Pemakaian"));
  for (const line of lines) assert.ok([...line].length <= 38, line);
});

test("every logo frame has the same size and fits the left column", () => {
  for (const phase of [null, 0, 0.25, 0.5, 0.75]) {
    const lines = logoFrame("truecolor", phase).map(plain);
    assert.equal(lines.length, 11);
    for (const line of lines) assert.equal([...line].length, 24);
  }
});

test("the comet moves around the halo and the N's cells stay put", () => {
  const nCells = (lines: string[]) => lines.map(plain).join("").replace(/[^#%|]/g, "").length;
  const quarter = logoFrame("truecolor", 0.25);
  const threeQuarter = logoFrame("truecolor", 0.75);
  assert.notDeepEqual(quarter, threeQuarter);
  assert.equal(nCells(quarter), nCells(threeQuarter));
  assert.equal(nCells(quarter), nCells(logoFrame("truecolor")));
});

test("the halo's near side crosses the N and its far side goes behind it", () => {
  const ring = /[.\-~=*()]/;
  const lines = logoFrame("truecolor").map(plain);
  // Row 7: the near arc runs over the left pillar, which is solid there without the ring.
  assert.ok(ring.test(lines[7].slice(3, 7)), lines[7]);
  // Row 4: the far arc reaches the right pillar, whose cells stay solid.
  assert.ok(!ring.test(lines[4].slice(14, 20)), lines[4]);
  assert.ok(ring.test(lines[4].slice(20)), lines[4]);
});

/** Mounts the extension's header on a fake TUI; `docRows` is the rendered document height. */
function mount(docRows: number, entries: unknown[] = []) {
  const handlers: Record<string, (event: unknown, ctx?: unknown) => void> = {};
  let onSummary: (data: unknown) => void = () => {};
  let renders = 0;
  const tui = {
    terminal: { columns: 120, rows: 30 },
    render: () => Array<string>(docRows).fill(""),
    requestRender: () => {
      renders++;
    },
  };
  let component: { render(width: number): string[]; dispose(): void } | undefined;
  brand({
    events: {
      on: (_channel: string, fn: (data: unknown) => void) => {
        onSummary = fn;
      },
    },
    on: (name: string, fn: (event: unknown, ctx?: unknown) => void) => {
      handlers[name] = fn;
    },
  } as unknown as ExtensionAPI);
  handlers.session_start(
    { reason: "startup" },
    {
      mode: "tui",
      cwd: tmpdir(),
      model: { name: "m", provider: "p" },
      sessionManager: {
        getEntries: () => entries,
        getSessionFile: () => undefined,
        getSessionDir: () => join(tmpdir(), "nusacode-no-such-dir"),
      },
      ui: {
        setFooter: () => {},
        setHiddenThinkingLabel: () => {},
        setHeader: (factory: (tui: unknown, theme: Theme) => typeof component) => {
          component = factory(tui, theme);
        },
      },
    },
  );
  const text = () => component!.render(120).map(plain).join("\n");
  return { handlers, onSummary, text, component: component!, renders: () => renders };
}

test("the halo animates only while the logo is on screen and the session is new", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const animates = (m: ReturnType<typeof mount>) => {
    t.after(() => m.component.dispose());
    const before = m.renders();
    t.mock.timers.tick(1_000);
    return m.renders() > before;
  };
  assert.equal(animates(mount(30)), true);
  assert.equal(animates(mount(30 + 6)), false, "logo above the viewport");
  assert.equal(animates(mount(30, [{ type: "message" }])), false, "resumed session");
});

test("the first agent turn stops the halo", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const m = mount(30);
  t.mock.timers.tick(1_000);
  m.handlers.agent_start({});
  const before = m.renders();
  t.mock.timers.tick(1_000);
  assert.equal(m.renders(), before);
});

test("usage rows apply until the first agent turn, then the box is frozen", () => {
  const m = mount(30);
  m.onSummary({ rows: [{ label: "Saldo", value: "Rp 1" }] });
  assert.ok(m.text().includes("Rp 1"));

  m.handlers.agent_start({});
  m.onSummary({ rows: [{ label: "Saldo", value: "Rp 2" }] });
  assert.ok(!m.text().includes("Rp 2"));
  assert.ok(m.text().includes("Rp 1"));
});

const bar: StatusBarView = {
  model: "deepseek-v4.1-flash",
  folder: "nusacode",
  branch: "main",
  context: { tokens: 3_100, contextWindow: 1_048_576, percent: 0.3 },
  autoCompact: true,
  statuses: ["nusa · Rp 5 · 3.1k tok · 42 tok/s"],
};

test("status bar puts the session left and the meter right on one line", () => {
  const lines = statusBarLines(bar, 100, theme).map(plain);
  assert.equal(lines.length, 1);
  assert.equal([...lines[0]].length, 100);
  assert.ok(lines[0].startsWith("◆ deepseek-v4.1-flash · nusacode · main · 0.3%/1M ⟲"), lines[0]);
  assert.ok(lines[0].endsWith("nusa · Rp 5 · 3.1k tok · 42 tok/s"), lines[0]);
});

test("status bar moves the meter to its own line when both don't fit", () => {
  const lines = statusBarLines(bar, 60, theme).map(plain);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith("nusa"), lines[1]);
  for (const line of statusBarLines(bar, 20, theme).map(plain)) assert.ok([...line].length <= 20, line);
});

test("status bar shows optional parts only when they apply", () => {
  const [line] = statusBarLines(
    { ...bar, thinking: "high", sessionName: "rilis", branch: null, context: undefined, autoCompact: false, statuses: [] },
    100,
    theme,
  ).map(plain);
  assert.equal(line, "◆ deepseek-v4.1-flash • high · nusacode · rilis");
});

test("the spinner names what each tool is working on", () => {
  assert.equal(describeTool("read", { path: "README.md" }), "Membaca README.md");
  assert.equal(describeTool("bash", { command: "npm  test\n--watch" }), "Menjalankan npm test --watch");
  assert.equal(describeTool("grep", { pattern: "foo" }), "Mencari foo");
  assert.equal(describeTool("write", {}), "Menulis");
  assert.equal(describeTool("web_fetch", { url: "x" }), "Memakai web_fetch");
  assert.equal(describeTool("read", null), "Membaca");
  assert.ok(describeTool("bash", { command: "x".repeat(500) }).length < 80);
});

test("timeAgo buckets", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const ago = (ms: number) => timeAgo(new Date(now.getTime() - ms), now);
  assert.equal(ago(10_000), "baru saja");
  assert.equal(ago(5 * 60_000), "5 mnt lalu");
  assert.equal(ago(3 * 3_600_000), "3 jam lalu");
  assert.equal(ago(2 * 86_400_000), "2 hari lalu");
});

test("sessionLabel prefers the name, then flattens the first prompt", () => {
  assert.equal(sessionLabel({ name: "rilis", firstMessage: "x", messageCount: 2 }), "rilis");
  assert.equal(sessionLabel({ firstMessage: "baris satu\n  baris dua", messageCount: 2 }), "baris satu baris dua");
  assert.equal(sessionLabel({ firstMessage: "(no messages)", messageCount: 0 }), "Tanpa judul");
});
