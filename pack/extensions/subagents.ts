/**
 * NusaCode subagents: the `task` tool runs a child `pi` in JSON mode.
 *
 * Every call is a fresh, non-interactive `pi --mode json --no-session` process
 * with its own context window, started in the parent's cwd. Recursion is
 * blocked structurally, three times over: the child starts with
 * `--no-extensions` so this package is never loaded, its environment carries
 * `NUSACODE_SUBAGENT=1` so this file registers nothing if it is loaded anyway,
 * and `--tools` is an allowlist that never contains `task`.
 *
 * Child token usage is republished on the shared extension event bus as
 * `nusacode:usage`; meter.ts folds it into the parent's meter.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MODEL = "nusagate/deepseek-v4.1-flash";
const DEFAULT_TOOLS = "read,grep,find,ls";
/** PLAN decision 6: a cost guard, not a preference. */
const MAX_CONCURRENT = 4;
const TIMEOUT_MS = Number(process.env.NUSACODE_SUBAGENT_TIMEOUT_MS ?? 600_000);
const USAGE_CHANNEL = "nusacode:usage";
const STDERR_TAIL = 2_000;

type Json = Record<string, unknown>;

type Agent = {
  name: string;
  model: string;
  tools: string;
  systemPrompt: string;
};

type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };

type RunResult = {
  ok: boolean;
  text: string;
  error?: string;
  usage: Usage;
  toolCalls: number;
  durationMs: number;
};

const ZERO_USAGE: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function totalUsage(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Agent definitions live next to pi's own config, which the launcher points at the nusacode home. */
function agentsDir(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".nusacode"), "agents");
}

/** Frontmatter is a flat `key: value` block; anything richer would need a YAML dependency. */
function parseAgent(fallbackName: string, text: string): Agent | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  const systemPrompt = match[2].trim();
  if (!systemPrompt) return null;
  return {
    name: meta.name || fallbackName,
    model: meta.model || DEFAULT_MODEL,
    // `--tools` is comma-separated; spaces in the frontmatter list must not reach it.
    tools: (meta.tools || DEFAULT_TOOLS)
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean)
      .join(","),
    systemPrompt,
  };
}

function loadAgents(): Map<string, Agent> {
  const agents = new Map<string, Agent>();
  const dir = agentsDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return agents;
  }
  for (const file of files) {
    try {
      const agent = parseAgent(file.slice(0, -3), readFileSync(join(dir, file), "utf8"));
      if (agent) agents.set(agent.name, agent);
    } catch {
      // An unreadable agent file must not take the tool down; it is simply absent.
    }
  }
  return agents;
}

/**
 * The pi CLI entry to hand the child. Inside `node <cli.js>` that is the script
 * itself; a packaged binary has no script argument and re-runs itself.
 */
function childCommand(): { file: string; args: string[] } {
  const entry = process.argv[1];
  if (entry && /\.[cm]?js$/.test(entry) && existsSync(entry)) return { file: process.execPath, args: [entry] };
  return { file: process.execPath, args: [] };
}

function runAgent(
  agent: Agent,
  prompt: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((result: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined,
  onUsage: (provider: unknown, model: unknown, usage: Usage) => void,
): Promise<RunResult> {
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  const command = childCommand();
  const child = spawn(
    command.file,
    [
      ...command.args,
      "--mode", "json",
      "--no-session",
      "--approve",
      "--no-extensions",
      "--no-mcp",
      "--tools", agent.tools,
      "--model", agent.model,
      "--system-prompt", agent.systemPrompt,
      prompt,
    ],
    {
      cwd,
      env: { ...process.env, NUSACODE_SUBAGENT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  const started = Date.now();
  const usage: Usage = { ...ZERO_USAGE };
  let text = "";
  let toolCalls = 0;
  let stderr = "";
  let buffer = "";
  let settled = false;

  const finish = (result: RunResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolve(result);
  };

  const failed = (error: string) =>
    finish({ ok: false, text, error, usage, toolCalls, durationMs: Date.now() - started });

  const kill = (reason: string) => {
    child.kill();
    failed(reason);
  };

  const timer = setTimeout(() => kill(`timed out after ${Math.round(TIMEOUT_MS / 1000)}s`), TIMEOUT_MS);
  const onAbort = () => kill("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });

  const handle = (line: string) => {
    let record: Json;
    try {
      record = JSON.parse(line);
    } catch {
      return; // A malformed line is one lost event, not a failed run.
    }
    if (record.type !== "message_end") return;
    const message = asRecord(record.message);
    if (!message || message.role !== "assistant") return;

    const reported = asRecord(message.usage);
    if (reported) {
      const delta: Usage = {
        input: num(reported.input),
        cacheRead: num(reported.cacheRead),
        cacheWrite: num(reported.cacheWrite),
        output: num(reported.output),
      };
      usage.input += delta.input;
      usage.cacheRead += delta.cacheRead;
      usage.cacheWrite += delta.cacheWrite;
      usage.output += delta.output;
      onUsage(message.provider, message.model, delta);
    }

    const content = Array.isArray(message.content) ? message.content : [];
    let answer = "";
    for (const part of content) {
      const block = asRecord(part);
      if (!block) continue;
      if (block.type === "toolCall") toolCalls += 1;
      if (block.type === "text" && typeof block.text === "string") answer += block.text;
    }
    if (answer.trim()) text = answer;
    onUpdate?.({
      content: [{ type: "text", text: `${agent.name}: ${toolCalls} tool call(s), ${formatTokens(totalUsage(usage))} tok` }],
      details: { agent: agent.name, toolCalls, usage },
    });
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line) handle(line);
    }
  });
  // stderr is diagnostics only; it never enters the JSONL protocol.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  child.on("error", (err) => failed(err.message));
  child.on("exit", (code) => {
    if (buffer.trim()) handle(buffer.replace(/\r$/, ""));
    if (code !== 0) failed(`exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    else if (!text) failed(`no answer${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    else finish({ ok: true, text, usage, toolCalls, durationMs: Date.now() - started });
  });
  return promise;
}

export default function subagents(pi: ExtensionAPI) {
  // The child sets this; see the header. Registering `task` there would allow
  // unbounded recursive fan-out.
  if (process.env.NUSACODE_SUBAGENT === "1") return;

  const known = [...loadAgents().keys()];
  const agentList = known.length > 0 ? known.join(", ") : "(none; see agents/ in the nusacode home)";

  // FIFO gate. One session's own agent loop is never run twice: children are
  // separate `--no-session` processes, so no session can overlap with itself.
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = (): Promise<void> => {
    if (active < MAX_CONCURRENT) {
      active += 1;
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    waiting.push(() => {
      active += 1;
      resolve();
    });
    return promise;
  };
  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };

  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Delegate a self-contained task to a subagent: a separate non-interactive pi process with its own context " +
      "window and only the tools its agent definition allows. Use it to keep broad exploration out of this " +
      "conversation. It cannot see this conversation, so put every fact it needs in the prompt. Returns the " +
      `subagent's final answer. Agents: ${agentList}.`,
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({ description: `Agent name: ${agentList}. Defaults to explorer.` }),
      ),
      prompt: Type.String({ description: "Complete instructions for the subagent; it has no access to this conversation." }),
    }),
    // Fan-out is the point; a global sequential setting must not serialize it.
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const available = loadAgents();
      const wanted = (params.agent ?? "explorer").trim() || "explorer";
      const agent = available.get(wanted);
      if (!agent) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown agent "${wanted}". Available: ${[...available.keys()].join(", ") || "none"}.`,
            },
          ],
          details: { agent: wanted },
          isError: true,
        };
      }

      await acquire();
      try {
        if (signal?.aborted) {
          return { content: [{ type: "text" as const, text: `[${agent.name}] aborted before start` }], details: { agent: agent.name }, isError: true };
        }
        const result = await runAgent(agent, params.prompt, ctx.cwd, signal, onUpdate, (provider, model, usage) => {
          pi.events.emit(USAGE_CHANNEL, { source: "subagent", agent: agent.name, provider, model, usage });
        });
        const total = totalUsage(result.usage);
        const details = {
          agent: agent.name,
          model: agent.model,
          ok: result.ok,
          toolCalls: result.toolCalls,
          durationMs: result.durationMs,
          usage: { ...result.usage, total },
        };
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `[${agent.name} failed] ${result.error ?? "unknown error"}` }],
            details,
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.text}\n[${agent.name} · ${formatTokens(total)} tok · ${result.toolCalls} tool call(s)]`,
            },
          ],
          details,
        };
      } finally {
        release();
      }
    },
  });
}
