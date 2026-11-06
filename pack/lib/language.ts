/**
 * The language NusaCode's own screens are drawn in: English (the default) or
 * Bahasa Indonesia. It changes the TUI only; what the agent replies in is up to
 * the conversation. Kept in `language.json` in the NusaCode home.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LANGUAGE_FILE = "language.json";

export type LanguageId = "en" | "id";

export interface Language {
  readonly id: LanguageId;
  /** The language's name in that language, so everyone can find their own. */
  readonly label: string;
  /** A line of NusaCode's UI in that language, so the choice shows what it means. */
  readonly sample: string;
}

export const LANGUAGES: readonly Language[] = [
  { id: "en", label: "English", sample: "Welcome! Your balance is Rp 48.760." },
  { id: "id", label: "Bahasa Indonesia", sample: "Selamat datang! Saldo kamu Rp 48.760." },
];

export const DEFAULT_LANGUAGE: LanguageId = "en";

export function findLanguage(id: string): Language | undefined {
  const needle = id.trim().toLowerCase();
  return LANGUAGES.find(
    (l) => l.id === needle || l.label.toLowerCase() === needle || (needle === "indonesian" && l.id === "id"),
  );
}

/** The saved language, or null when none has been chosen yet. */
export function readLanguage(dir: string): LanguageId | null {
  try {
    const id: unknown = JSON.parse(readFileSync(join(dir, LANGUAGE_FILE), "utf8")).language;
    return typeof id === "string" && LANGUAGES.some((l) => l.id === id) ? (id as LanguageId) : null;
  } catch {
    return null;
  }
}

export function writeLanguage(dir: string, id: LanguageId): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, LANGUAGE_FILE);
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ language: id }, null, 2)}\n`);
  renameSync(temp, target);
}
