/**
 * Is there a newer NusaCode on npm?
 *
 * Asked on every start, so a release shows on the welcome screen the next time
 * NusaCode opens. The caller doesn't await it, so it never delays startup: the
 * notice appears once npm answers. The answer is kept in `update-check.json` in the
 * NusaCode home, and used when npm can't be reached (offline, or slower than the
 * timeout). Nothing here throws.
 *
 * Skipped when running from a git checkout (its package.json version is never
 * bumped, so it would always look out of date), and with `NUSACODE_NO_UPDATE_CHECK=1`
 * or `PI_OFFLINE=1`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UPDATE_FILE = "update-check.json";
/** What the welcome screen tells people to type: NusaCode updates itself (pack/extensions/update.ts). */
export const UPDATE_COMMAND = "/update";
const TIMEOUT_MS = 3_000;
const REGISTRY_URL = "https://registry.npmjs.org/nusacode/latest";

type Cache = { checkedAt: number; latest: string | null };

/** Plain `x.y.z` only; anything else (a pre-release, garbage) is not comparable. */
function parse(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `latest` is a higher release than `current`. */
export function isNewer(current: string, latest: string): boolean {
  const a = parse(current);
  const b = parse(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i]! > a[i]!;
  return false;
}

export function readCache(dir: string): Cache | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, UPDATE_FILE), "utf8")) as Partial<Cache>;
    if (typeof raw.checkedAt !== "number") return null;
    return { checkedAt: raw.checkedAt, latest: typeof raw.latest === "string" ? raw.latest : null };
  } catch {
    return null;
  }
}

function writeCache(dir: string, cache: Cache): void {
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, UPDATE_FILE);
    writeFileSync(`${target}.tmp`, `${JSON.stringify(cache)}\n`);
    renameSync(`${target}.tmp`, target);
  } catch {
    // Only costs an extra check next time.
  }
}

async function fetchLatest(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const version = ((await res.json()) as { version?: unknown }).version;
    return typeof version === "string" && parse(version) ? version : null;
  } catch {
    return null;
  }
}

export interface UpdateCheckOptions {
  /** The running version. */
  current: string;
  /** Where the answer is cached: the NusaCode home. */
  dir: string;
  /** The NusaCode install's own folder; a `.git` there means a checkout. */
  installDir: string;
  now?: number;
  fetchImpl?: typeof fetch;
  url?: string;
  env?: NodeJS.ProcessEnv;
}

/** The newer version on npm, or null when this one is current, unknown, or the check is off. */
export async function availableUpdate(options: UpdateCheckOptions): Promise<string | null> {
  const env = options.env ?? process.env;
  if (env.NUSACODE_NO_UPDATE_CHECK === "1" || env.PI_OFFLINE === "1") return null;
  if (existsSync(join(options.installDir, ".git"))) return null;
  const latest = await fetchLatest(options.fetchImpl ?? fetch, options.url ?? REGISTRY_URL);
  // A failed request keeps the last known answer; only a real answer is saved.
  const known = latest ?? readCache(options.dir)?.latest ?? null;
  if (latest) writeCache(options.dir, { checkedAt: options.now ?? Date.now(), latest });
  return known && isNewer(options.current, known) ? known : null;
}
