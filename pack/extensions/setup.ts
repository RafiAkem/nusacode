/**
 * NusaCode first-time setup and import from other coding agents.
 *
 * Setup runs once on a new session: it asks for a NusaGate API key if there is
 * none, then offers to import from each agent it finds. `/setup` runs it again
 * and `/import-config` runs only the import.
 *
 * Import copies skills and one global instructions file. It asks per source,
 * never overwrites, and leaves credentials and MCP servers behind: those hold
 * secrets and start processes, so copying them silently would be unsafe.
 *
 * `NUSACODE_SKIP_SETUP=1` skips the automatic run.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { runSetupSplash } from "../lib/splash.ts";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BALANCE_URL, KEY_CHANNEL } from "./meter.ts";

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

function nusacodeHome(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".nusacode");
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
export function scanSources(userHome: string, skillsDir: string): ImportSource[] {
  const taken = new Set<string>();
  for (const root of [skillsDir, ...ALREADY_LOADED.map((dir) => join(userHome, dir))]) {
    for (const skill of findSkills(root)) taken.add(skill.name);
  }
  const sources: ImportSource[] = [];
  for (const agent of AGENTS) {
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

export async function checkApiKey(key: string): Promise<"ok" | "rejected" | "unreachable"> {
  try {
    const res = await fetch(process.env.NUSAGATE_BALANCE_URL || BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return "rejected";
    return res.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
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
    parts.push(`${source.skills.length} skill(s): ${names.join(", ")}${more > 0 ? `, +${more} more` : ""}`);
  }
  if (source.instructions) parts.push(`Global instructions: ${basename(source.instructions)}`);
  parts.push("These will load in your NusaCode sessions. API keys and MCP servers are not copied.");
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
    if (!(await ctx.ui.confirm(`Import from ${source.label}?`, describeSource(source)))) continue;
    results.push(importSource(source, home));
  }
  return results;
}

function importSummary(results: ImportResult[]): string | null {
  const imported = results.flatMap((result) => result.imported);
  const skipped = results.flatMap((result) => result.skipped);
  const instructions = results.some((result) => result.instructions);
  if (imported.length === 0 && !instructions && skipped.length === 0) return null;
  const lines = [`Imported ${imported.length} skill(s)${instructions ? " and global instructions" : ""}. They apply from your next session.`];
  if (skipped.length > 0) lines.push(`Skipped (already there or too large): ${skipped.join(", ")}`);
  return lines.join("\n");
}

export default function setup(pi: ExtensionAPI) {
  if (process.env.NUSACODE_SUBAGENT === "1") return;

  async function askForKey(ctx: ExtensionContext): Promise<void> {
    if (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER).catch(() => undefined)) return;
    let title = `NusaGate API key (get one at ${API_KEYS_URL})`;
    for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt++) {
      const key = (await ctx.ui.input(title, "nsk_..."))?.trim();
      if (!key) break;
      const check = await checkApiKey(key);
      if (check === "rejected") {
        title = "NusaGate rejected that API key. Try again:";
        continue;
      }
      if (!saveApiKey(nusacodeHome(), key)) {
        ctx.ui.notify("Could not read auth.json, so the API key was not saved. Set NUSAGATE_API_KEY instead.", "error");
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
      if (check === "unreachable") ctx.ui.notify("Could not reach NusaGate, so the API key was saved without being checked.", "warning");
      return;
    }
    ctx.ui.notify("No API key yet. Run /setup or set NUSAGATE_API_KEY.", "warning");
  }

  async function runSetup(ctx: ExtensionContext): Promise<void> {
    // The splash is NusaCode's only full-screen moment; keep an escape hatch for
    // scripted runs. It is cosmetic, so a failure must never block setup.
    if (process.env.NUSACODE_NO_SPLASH !== "1") {
      try {
        await runSetupSplash(ctx);
      } catch {
        // Fall through to the key prompt.
      }
    }
    await askForKey(ctx);
    const summary = importSummary(await runImport(ctx));
    // Marked at the end, so quitting halfway asks again next time.
    markSetupDone(nusacodeHome());
    ctx.ui.notify(summary ? `Setup complete.\n${summary}` : "Setup complete.", "info");
  }

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui" || event.reason !== "startup" || process.env.NUSACODE_SKIP_SETUP === "1") return;
    if (setupIsDone(nusacodeHome())) return;
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) return;
    // Not awaited: session_start handlers block startup, and dialogs need it finished.
    void runSetup(ctx).catch((err: unknown) => {
      ctx.ui.notify(`Setup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    });
  });

  pi.registerCommand("setup", {
    description: "Run first-time setup again: API key and import from other agents",
    handler: async (_args, ctx) => runSetup(ctx),
  });

  pi.registerCommand("import-config", {
    description: "Import skills and instructions from Claude Code, Codex, oh-my-pi, pi, or OpenCode",
    handler: async (_args, ctx) => {
      const summary = importSummary(await runImport(ctx));
      ctx.ui.notify(summary ?? "Nothing was imported.", "info");
    },
  });
}
