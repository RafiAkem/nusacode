import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./home.ts";
import { normalizeRelayUrl } from "./relay-client.ts";

const FILE = "remote.json";

/** The relay to use: NUSACODE_RELAY_URL, else the one saved with `/remote relay <address>`. */
export function configuredRelay(): string | undefined {
  const fromEnv = process.env.NUSACODE_RELAY_URL;
  if (fromEnv) return normalizeRelayUrl(fromEnv);
  try {
    const saved = (JSON.parse(readFileSync(join(agentDir(), FILE), "utf8")) as { relay?: unknown }).relay;
    return typeof saved === "string" ? normalizeRelayUrl(saved) : undefined;
  } catch {
    return undefined;
  }
}

/** Saves the relay address; returns it normalized, or undefined if it isn't a usable address. */
export function saveRelay(input: string): string | undefined {
  const relay = normalizeRelayUrl(input);
  if (!relay) return undefined;
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(join(agentDir(), FILE), `${JSON.stringify({ relay }, null, 2)}\n`);
  return relay;
}
