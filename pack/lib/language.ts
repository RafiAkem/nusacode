/**
 * The language the agent replies in. NusaCode's own screens stay English; this
 * only adds a line to the system prompt. Kept in `language.json` in the NusaCode home.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LANGUAGE_FILE = "language.json";

export type LanguageId = "en" | "id" | "auto";

export interface Language {
  readonly id: LanguageId;
  readonly label: string;
  /** A line in that language, so the choice shows what it means. */
  readonly sample: string;
  /** Added to the system prompt; null adds nothing. */
  readonly instruction: string | null;
}

const KEEP = "Keep code, identifiers, commands, file paths, error messages and technical terms exactly as they are.";

export const LANGUAGES: readonly Language[] = [
  {
    id: "en",
    label: "English",
    sample: "Done. I fixed the two failing tests.",
    instruction: `Always reply in English, even when the user writes in another language. ${KEEP}`,
  },
  {
    id: "id",
    label: "Bahasa Indonesia",
    sample: "Selesai. Dua tes yang gagal sudah saya perbaiki.",
    instruction: `Always reply in Bahasa Indonesia, even when the user writes in another language. ${KEEP}`,
  },
  {
    id: "auto",
    label: "Match my messages",
    sample: "Replies in whatever language you write in",
    instruction: null,
  },
];

export const DEFAULT_LANGUAGE: LanguageId = "en";

export function findLanguage(id: string): Language | undefined {
  const needle = id.trim().toLowerCase();
  return LANGUAGES.find((l) => l.id === needle || l.label.toLowerCase() === needle);
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

/** The system prompt with the language line added, or unchanged when there is none to add. */
export function withLanguage(systemPrompt: string, id: LanguageId | null): string {
  const instruction = id ? LANGUAGES.find((l) => l.id === id)?.instruction : null;
  if (!instruction) return systemPrompt;
  return `${systemPrompt}\n\n<reply_language>\n${instruction}\n</reply_language>`;
}
