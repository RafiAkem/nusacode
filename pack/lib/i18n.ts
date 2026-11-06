/**
 * NusaCode's UI language. English is the default and the source; Bahasa Indonesia
 * is the other choice, picked in `/setup` or with `/language`.
 *
 * Each area of the UI declares its own messages next to its code:
 *
 *   const t = messages(
 *     { saved: "Saved {count} skills" },
 *     { saved: "{count} skill disimpan" },
 *   );
 *   t("saved", { count: 3 });
 *
 * The Indonesian table has to have every key the English one has (the type says
 * so), and `{name}` placeholders are filled from `vars`. Only NusaCode's own text is
 * translated: pi's screens stay English, and so does anything the model reads.
 */
import { readLanguage } from "./language.ts";
import { agentDir } from "./home.ts";

export type Locale = "en" | "id";

let current: Locale | null = null;

/**
 * The language in use. It is read from the NusaCode home the first time it is
 * needed, but only when running under the launcher: tests and scripts that import
 * these modules always get English, whatever the developer picked for themselves.
 */
export function locale(): Locale {
  if (current === null) {
    const underLauncher = Boolean(process.env.NUSACODE_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR);
    current = (underLauncher ? readLanguage(agentDir()) : null) ?? "en";
  }
  return current;
}

/** Switches the language for everything drawn from now on. */
export function setLocale(next: Locale): void {
  current = next;
}

export type Vars = Record<string, string | number>;

/** Fills `{name}` placeholders; a placeholder with no value is left as written. */
export function format(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** Every table registered, so a test can check that the two languages line up. */
export const REGISTRY: { en: Record<string, string>; id: Record<string, string> }[] = [];

export function messages<const T extends Record<string, string>>(
  en: T,
  id: { readonly [K in keyof T]: string },
): (key: keyof T & string, vars?: Vars) => string {
  REGISTRY.push({ en, id: id as Record<string, string> });
  return (key, vars) => format((locale() === "id" ? id[key] : undefined) ?? en[key], vars);
}
