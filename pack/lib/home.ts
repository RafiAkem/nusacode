import { homedir } from "node:os";
import { join } from "node:path";

/**
 * NusaCode's home folder: settings, sessions, skills, agents.
 * The launcher sets NUSACODE_CODING_AGENT_DIR; PI_CODING_AGENT_DIR is the older name for it.
 */
export function agentDir(): string {
  return process.env.NUSACODE_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".nusacode");
}
