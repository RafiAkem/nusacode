/**
 * NusaCode first-time setup and import from other coding agents.
 *
 * Setup runs once on a new session, as a full-screen wizard: a splash, then the
 * reply language, the NusaGate API key, the default model, an import from any other agents it finds,
 * and a closing summary. `/setup` runs it again and `/import-config` runs only
 * the import. Outside the TUI it falls back to plain dialogs.
 *
 * Import copies skills and one global instructions file. You pick the sources,
 * it never overwrites, and it leaves credentials and MCP servers behind: those
 * hold secrets and start processes, so copying them silently would be unsafe.
 *
 * `NUSACODE_SKIP_SETUP=1` skips the automatic run; `NUSACODE_NO_SPLASH=1` skips
 * the splash.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BALANCE_URL, CATALOG_CHANNEL, KEY_CHANNEL, parsePrice, type Price } from "./meter.ts";
import { agentDir } from "../lib/home.ts";
import { DEFAULT_LANGUAGE, LANGUAGES, readLanguage, writeLanguage, type LanguageId } from "../lib/language.ts";
import { locale, messages, setLocale } from "../lib/i18n.ts";
import {
  importStep,
  keyStep,
  languageStep,
  modelStep,
  readyStep,
  type ImportReport,
  type KeyCheck,
  type KeyOutcome,
  type ModelChoice,
  type SetupSummary,
} from "../lib/setup-steps.ts";
import { runSetupWizard, type StepDefinition } from "../lib/setup-wizard.ts";

const PROVIDER = "nusagate";
const DEFAULT_MODEL = "deepseek-v4.1-flash";
const PLACEHOLDER_MODEL = "unknown";
const API_KEYS_URL = "https://nusagate.com/dashboard";
const MARKER_FILE = "setup.json";
const SETUP_VERSION = 1;
const KEY_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_SKILL_DEPTH = 3;
const MAX_SKILL_BYTES = 5_000_000;
const NAMES_IN_PROMPT = 8;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Where each agent keeps skills and global instructions, relative to the user's home. */
const AGENTS = [
  { label: "Claude Code", skills: [".claude/skills"], instructions: [".claude/CLAUDE.md"] },
  { label: "Codex", skills: [".codex/skills"], instructions: [".codex/AGENTS.md"] },
  { label: "oh-my-pi", skills: [".omp/agent/skills"], instructions: [".omp/agent/AGENTS.md"] },
  { label: "pi", skills: [".pi/agent/skills"], instructions: [".pi/agent/AGENTS.md"] },
  { label: "OpenCode", skills: [".config/opencode/skills"], instructions: [".config/opencode/AGENTS.md"] },
];
/** pi loads these itself, so copying them would only create duplicates. */
const ALREADY_LOADED = [".agents/skills"];

export type FoundSkill = { name: string; dir: string };
export type ImportSource = { label: string; skills: FoundSkill[]; instructions: string | null };
export type ImportResult = { imported: string[]; skipped: string[]; instructions: boolean };

const t = messages(
  {
    skills: "{count} skill(s): {names}",
    more: ", +{count} more",
    instructions: "Global instructions: {file}",
    willLoad: "These will load in your NusaCode sessions. API keys and MCP servers are not copied.",
    importFrom: "Import from {label}?",
    imported: "Imported {count} skill(s). They apply from your next session.",
    importedWithInstructions: "Imported {count} skill(s) and global instructions. They apply from your next session.",
    skipped: "Skipped (already there or too large): {names}",
    keyTitle: "NusaGate API key (get one at {url})",
    keyRejected: "NusaGate rejected that API key. Try again:",
    authUnreadable: "Could not read auth.json, so the API key was not saved. Set NUSAGATE_API_KEY instead.",
    keyUnchecked: "Could not reach NusaGate, so the API key was saved without being checked.",
    noKey: "No API key yet. Run /setup or set NUSAGATE_API_KEY.",
    authUnreadableShort: "auth.json could not be read, so the key was not saved. Set NUSAGATE_API_KEY instead.",
    languageNotSaved: "The language could not be saved: {message}",
    closed: "Setup closed. Run /setup whenever you want it back.",
    complete: "Setup complete.",
    failed: "Setup failed: {message}",
    setupDescription: "Run first-time setup again: language, API key, default model and import from other agents",
    importDescription: "Import skills and instructions from Claude Code, Codex, oh-my-pi, pi, or OpenCode",
    nothingToImport: "Nothing to import: no new skills or instructions from other agents.",
    nothingImported: "Nothing was imported.",
  },
  {
    skills: "{count} skill: {names}",
    more: ", +{count} lagi",
    instructions: "Instruksi global: {file}",
    willLoad: "Ini akan dipakai di sesi NusaCode kamu. API key dan server MCP tidak ikut disalin.",
    importFrom: "Impor dari {label}?",
    imported: "{count} skill diimpor. Mulai dipakai di sesi berikutnya.",
    importedWithInstructions: "{count} skill dan instruksi global diimpor. Mulai dipakai di sesi berikutnya.",
    skipped: "Dilewati (sudah ada atau terlalu besar): {names}",
    keyTitle: "API key NusaGate (buat di {url})",
    keyRejected: "NusaGate menolak API key itu. Coba lagi:",
    authUnreadable: "auth.json tidak bisa dibaca, jadi API key tidak disimpan. Atur NUSAGATE_API_KEY sebagai gantinya.",
    keyUnchecked: "NusaGate tidak bisa dihubungi, jadi API key disimpan tanpa dicek.",
    noKey: "Belum ada API key. Jalankan /setup atau atur NUSAGATE_API_KEY.",
    authUnreadableShort: "auth.json tidak bisa dibaca, jadi key tidak disimpan. Atur NUSAGATE_API_KEY sebagai gantinya.",
    languageNotSaved: "Bahasa tidak bisa disimpan: {message}",
    closed: "Setup ditutup. Jalankan /setup kapan saja kalau mau membukanya lagi.",
    complete: "Setup selesai.",
    failed: "Setup gagal: {message}",
    setupDescription: "Jalankan setup awal lagi: bahasa, API key, model default, dan impor dari agent lain",
    importDescription: "Impor skill dan instruksi dari Claude Code, Codex, oh-my-pi, pi, atau OpenCode",
    nothingToImport: "Tidak ada yang bisa diimpor: tidak ada skill atau instruksi baru dari agent lain.",
    nothingImported: "Tidak ada yang diimpor.",
  },
);

function nusacodeHome(): string {
  return agentDir();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Skill folders under `root`. Dot folders are skipped: agents keep deleted skills
 * in places like `skills/.trash`, which must not come back to life.
 */
export function findSkills(root: string, depth = MAX_SKILL_DEPTH): FoundSkill[] {
  if (depth < 0 || !isDirectory(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith(".") && name !== "node_modules")
    .sort()
    .flatMap((name) => {
      const dir = join(root, name);
      if (!isDirectory(dir)) return [];
      return existsSync(join(dir, "SKILL.md")) ? [{ name, dir }] : findSkills(dir, depth - 1);
    });
}

function hasContent(path: string): boolean {
  try {
    return statSync(path).isFile() && readFileSync(path, "utf8").trim() !== "";
  } catch {
    return false;
  }
}

/** Agents on this machine with something to import. A skill name goes to the first agent that has it. */
export function scanSources(userHome: string, skillsDir: string, include: (label: string) => boolean = () => true): ImportSource[] {
  const taken = new Set<string>();
  for (const root of [skillsDir, ...ALREADY_LOADED.map((dir) => join(userHome, dir))]) {
    for (const skill of findSkills(root)) taken.add(skill.name);
  }
  const sources: ImportSource[] = [];
  for (const agent of AGENTS.filter((candidate) => include(candidate.label))) {
    const skills = agent.skills.flatMap((dir) => findSkills(join(userHome, dir)));
    const fresh = skills.filter((skill) => {
      if (taken.has(skill.name) || !SKILL_NAME.test(skill.name)) return false;
      taken.add(skill.name);
      return true;
    });
    const instructions = agent.instructions.map((file) => join(userHome, file)).find(hasContent) ?? null;
    if (fresh.length > 0 || instructions) sources.push({ label: agent.label, skills: fresh, instructions });
  }
  return sources;
}

function directoryBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) continue;
    total += stats.isDirectory() ? directoryBytes(path) : stats.size;
  }
  return total;
}

/** Copies a source's skills and instructions, without overwriting anything already there. */
export function importSource(source: ImportSource, destinationHome: string): ImportResult {
  const skillsDir = join(destinationHome, "skills");
  const result: ImportResult = { imported: [], skipped: [], instructions: false };
  for (const skill of source.skills) {
    const target = join(skillsDir, skill.name);
    if (existsSync(target) || directoryBytes(skill.dir) > MAX_SKILL_BYTES) {
      result.skipped.push(skill.name);
      continue;
    }
    mkdirSync(skillsDir, { recursive: true });
    // Dot files such as .env stay behind, and a link could point anywhere.
    cpSync(skill.dir, target, {
      recursive: true,
      filter: (path) => !lstatSync(path).isSymbolicLink() && (path === skill.dir || !basename(path).startsWith(".")),
    });
    result.imported.push(skill.name);
  }
  const instructionsTarget = join(destinationHome, "AGENTS.md");
  if (source.instructions && !existsSync(instructionsTarget)) {
    mkdirSync(destinationHome, { recursive: true });
    writeFileSync(instructionsTarget, readFileSync(source.instructions));
    result.instructions = true;
  }
  return result;
}

/** Stores the key where pi reads credentials. Returns false rather than replace a file it can't parse. */
export function saveApiKey(destinationHome: string, key: string): boolean {
  const target = join(destinationHome, "auth.json");
  let auth: Record<string, unknown> = {};
  if (existsSync(target)) {
    try {
      auth = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      return false;
    }
  }
  mkdirSync(destinationHome, { recursive: true });
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...auth, [PROVIDER]: { type: "api_key", key } }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
  return true;
}

/** Asks the balance endpoint about a key; the balance comes back too when it is there. */
export async function verifyApiKey(key: string): Promise<KeyCheck> {
  try {
    const res = await fetch(process.env.NUSAGATE_BALANCE_URL || BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { status: "rejected" };
    if (!res.ok) return { status: "unreachable" };
    const body = (await res.json().catch(() => null)) as { balance?: unknown } | null;
    const balance = body?.balance;
    return typeof balance === "number" && Number.isFinite(balance) ? { status: "ok", balanceIdr: balance } : { status: "ok" };
  } catch {
    return { status: "unreachable" };
  }
}

export async function checkApiKey(key: string): Promise<"ok" | "rejected" | "unreachable"> {
  return (await verifyApiKey(key)).status;
}

export function setupIsDone(destinationHome: string): boolean {
  try {
    return JSON.parse(readFileSync(join(destinationHome, MARKER_FILE), "utf8")).version >= SETUP_VERSION;
  } catch {
    return false;
  }
}

function markSetupDone(destinationHome: string): void {
  mkdirSync(destinationHome, { recursive: true });
  writeFileSync(join(destinationHome, MARKER_FILE), `${JSON.stringify({ version: SETUP_VERSION })}\n`);
}

function describeSource(source: ImportSource): string {
  const parts: string[] = [];
  if (source.skills.length > 0) {
    const names = source.skills.slice(0, NAMES_IN_PROMPT).map((skill) => skill.name);
    const more = source.skills.length - names.length;
    parts.push(`${t("skills", { count: source.skills.length, names: names.join(", ") })}${more > 0 ? t("more", { count: more }) : ""}`);
  }
  if (source.instructions) parts.push(t("instructions", { file: basename(source.instructions) }));
  parts.push(t("willLoad"));
  return parts.join("\n");
}

async function runImport(ctx: ExtensionContext): Promise<ImportResult[]> {
  const home = nusacodeHome();
  const skillsDir = join(home, "skills");
  const results: ImportResult[] = [];
  // Scanned per step, so a skill taken from one source isn't offered by the next.
  for (const { label } of scanSources(homedir(), skillsDir)) {
    const source = scanSources(homedir(), skillsDir).find((candidate) => candidate.label === label);
    if (!source) continue;
    if (!(await ctx.ui.confirm(t("importFrom", { label: source.label }), describeSource(source)))) continue;
    results.push(importSource(source, home));
  }
  return results;
}

/**
 * Imports the named sources. They are scanned again with only those agents in play,
 * so a skill that an unpicked agent also has still comes from a picked one.
 */
export function importLabels(labels: string[], userHome: string, destinationHome: string): ImportReport[] {
  const picked = new Set(labels);
  return scanSources(userHome, join(destinationHome, "skills"), (label) => picked.has(label)).map((source) => ({
    label: source.label,
    ...importSource(source, destinationHome),
  }));
}

function importSummary(results: ImportResult[]): string | null {
  const imported = results.flatMap((result) => result.imported);
  const skipped = results.flatMap((result) => result.skipped);
  const instructions = results.some((result) => result.instructions);
  if (imported.length === 0 && !instructions && skipped.length === 0) return null;
  const lines = [t(instructions ? "importedWithInstructions" : "imported", { count: imported.length })];
  if (skipped.length > 0) lines.push(t("skipped", { names: skipped.join(", ") }));
  return lines.join("\n");
}

export default function setup(pi: ExtensionAPI) {
  if (process.env.NUSACODE_SUBAGENT === "1") return;

  async function askForKey(ctx: ExtensionContext): Promise<void> {
    if (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER).catch(() => undefined)) return;
    let title = t("keyTitle", { url: API_KEYS_URL });
    for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt++) {
      const key = (await ctx.ui.input(title, "nsk_..."))?.trim();
      if (!key) break;
      const check = await checkApiKey(key);
      if (check === "rejected") {
        title = t("keyRejected");
        continue;
      }
      if (!saveApiKey(nusacodeHome(), key)) {
        ctx.ui.notify(t("authUnreadable"), "error");
        return;
      }
      // pi resolves the configured key from this variable for the rest of the session.
      process.env.NUSAGATE_API_KEY = key;
      pi.events.emit(KEY_CHANNEL, { key });
      // pi snapshots credentials at startup, and with no key it started on a placeholder model.
      await ctx.modelRegistry.refresh();
      if (!ctx.model || ctx.model.id === PLACEHOLDER_MODEL) {
        const model = ctx.modelRegistry.find(PROVIDER, DEFAULT_MODEL);
        if (model) await pi.setModel(model);
      }
      if (check === "unreachable") ctx.ui.notify(t("keyUnchecked"), "warning");
      return;
    }
    ctx.ui.notify(t("noKey"), "warning");
  }

  /** Prices from the gateway catalog, for the model step. meter.ts fetches it each session. */
  const prices = new Map<string, Price>();
  pi.events.on(CATALOG_CHANNEL, (rows) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const id = (row as { id?: unknown } | null)?.id;
      const price = parsePrice(row);
      if (typeof id === "string" && price) prices.set(id, price);
    }
  });

  /**
   * Saves a key and switches the running session over to it. Resolves with a
   * message when it could not be saved.
   */
  async function storeKey(ctx: ExtensionContext, key: string): Promise<string | null> {
    if (!saveApiKey(nusacodeHome(), key)) return t("authUnreadableShort");
    // pi resolves the configured key from this variable for the rest of the session.
    process.env.NUSAGATE_API_KEY = key;
    pi.events.emit(KEY_CHANNEL, { key });
    // pi snapshots credentials at startup, and with no key it started on a placeholder model.
    await ctx.modelRegistry.refresh();
    if (!ctx.model || ctx.model.id === PLACEHOLDER_MODEL) {
      const model = ctx.modelRegistry.find(PROVIDER, DEFAULT_MODEL);
      if (model) await pi.setModel(model);
    }
    return null;
  }

  function gatewayModels(ctx: ExtensionContext): ModelChoice[] {
    return ctx.modelRegistry
      .getAvailable()
      .filter((model) => model.provider === PROVIDER && model.id !== PLACEHOLDER_MODEL)
      .map((model) => {
        const price = prices.get(model.id);
        const vision = model.input.includes("image");
        // models.ts puts "(vision)" in the name for /model; this table has its own column for it.
        const name = (model.name || model.id).replace(/ \(vision\)$/, "");
        return {
          id: model.id,
          name,
          inputPer1M: price?.inputPer1M,
          outputPer1M: price?.outputPer1M,
          contextWindow: model.contextWindow,
          vision,
        };
      });
  }

  function importChoices(): ImportSource[] {
    return scanSources(homedir(), join(nusacodeHome(), "skills"));
  }

  function importStepFor(sources: ImportSource[], onImported: (reports: ImportReport[]) => void): StepDefinition {
    return importStep({
      sources: sources.map((s) => ({ label: s.label, skills: s.skills.map((skill) => skill.name), instructions: s.instructions ? basename(s.instructions) : null })),
      run: (labels) => importLabels(labels, homedir(), nusacodeHome()),
      onImported,
    });
  }

  async function runWizard(ctx: ExtensionContext): Promise<boolean> {
    const existingKey = (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER).catch(() => undefined)) ?? null;
    const summary: SetupSummary = { language: null, key: null, model: null, imports: null };
    // The language step redraws the wizard in whichever language is highlighted;
    // if setup is closed before one is chosen, the old one comes back.
    const startLocale = locale();
    let hasKey = Boolean(existingKey);
    const steps: StepDefinition[] = [
      languageStep({
        languages: LANGUAGES,
        current: readLanguage(nusacodeHome()),
        fallback: DEFAULT_LANGUAGE,
        preview: (id) => setLocale(id as LanguageId),
        save: (id) => {
          try {
            writeLanguage(nusacodeHome(), id as LanguageId);
            return null;
          } catch (err) {
            return t("languageNotSaved", { message: err instanceof Error ? err.message : String(err) });
          }
        },
        onChosen: (choice) => {
          summary.language = choice.label;
        },
      }),
      keyStep({
        existingKey,
        dashboardUrl: API_KEYS_URL,
        verify: verifyApiKey,
        save: (key) => storeKey(ctx, key),
        onOutcome: (outcome: KeyOutcome) => {
          summary.key = outcome;
          if (outcome.kind === "saved") hasKey = true;
        },
      }),
      modelStep({
        // One model, or none because there is no key, leaves nothing to choose.
        skip: () => !hasKey || gatewayModels(ctx).length < 2,
        models: () => gatewayModels(ctx),
        currentId: () => (ctx.model?.provider === PROVIDER ? ctx.model.id : null),
        select: async (id) => {
          const model = ctx.modelRegistry.find(PROVIDER, id);
          return model ? pi.setModel(model) : false;
        },
        onChosen: (choice) => {
          const current = ctx.model?.provider === PROVIDER ? ctx.model : null;
          summary.model = choice ? { name: choice.name, chosen: true } : current ? { name: (current.name || current.id).replace(/ \(vision\)$/, ""), chosen: false } : null;
        },
      }),
    ];
    const sources = importChoices();
    if (sources.length > 0) steps.push(importStepFor(sources, (reports) => (summary.imports = reports)));
    steps.push(readyStep(() => summary));

    const outcome = await runSetupWizard(ctx, steps, { splash: process.env.NUSACODE_NO_SPLASH !== "1" });
    if (summary.language === null) setLocale(startLocale);
    if (outcome === null) return false;
    // Marked whether it was finished or closed with ctrl+c: closing it is an answer too.
    markSetupDone(nusacodeHome());
    if (outcome === "cancelled") ctx.ui.notify(t("closed"), "info");
    else if (summary.key?.kind === "skipped") ctx.ui.notify(t("noKey"), "warning");
    return true;
  }

  async function runSetup(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode === "tui" && ctx.hasUI && (await runWizard(ctx))) return;
    // No TUI: the same questions as plain dialogs.
    await askForKey(ctx);
    const summary = importSummary(await runImport(ctx));
    markSetupDone(nusacodeHome());
    ctx.ui.notify(summary ? `${t("complete")}\n${summary}` : t("complete"), "info");
  }

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui" || event.reason !== "startup" || process.env.NUSACODE_SKIP_SETUP === "1") return;
    if (setupIsDone(nusacodeHome())) return;
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) return;
    // Not awaited: session_start handlers block startup, and dialogs need it finished.
    void runSetup(ctx).catch((err: unknown) => {
      ctx.ui.notify(t("failed", { message: err instanceof Error ? err.message : String(err) }), "error");
    });
  });

  pi.registerCommand("setup", {
    description: t("setupDescription"),
    handler: async (_args, ctx) => runSetup(ctx),
  });

  pi.registerCommand("import-config", {
    description: t("importDescription"),
    handler: async (_args, ctx) => {
      if (ctx.mode === "tui" && ctx.hasUI) {
        const sources = importChoices();
        if (sources.length === 0) {
          ctx.ui.notify(t("nothingToImport"), "info");
          return;
        }
        if ((await runSetupWizard(ctx, [importStepFor(sources, () => {})], { splash: false })) !== null) return;
      }
      const summary = importSummary(await runImport(ctx));
      ctx.ui.notify(summary ?? t("nothingImported"), "info");
    },
  });
}
