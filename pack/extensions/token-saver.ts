/**
 * NusaCode token saver: three levers, cheapest first (PLAN M3).
 *
 * 1. Cache-prefix guard: hash the stable prefix (system prompt + tool list) on every provider
 *    request. A mid-session change invalidates the provider's prefix cache, so input tokens that
 *    were billed at the cache rate get billed at the full rate. Warn once per change; never block,
 *    never touch the payload.
 * 2. Tool-output truncation: cap `read` and `bash` results at 200 lines. pi 1.4.0 already caps at
 *    2000 lines / 50KB with its own pointer, so this tightens an existing limit instead of adding
 *    a second one.
 * 3. Thinking routing: the level comes from settings (`modelThinkingLevels` per model, else
 *    `defaultThinkingLevel`) and drops to `minimal` for a short mechanical prompt while the
 *    session has zero tool failures. Never hardcoded, never persisted.
 *
 * `NUSACODE_NO_TOKEN_SAVER=1` loads none of it; that is the A/B switch used for measurement.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Lines kept per `read`/`bash` result. `NUSACODE_TRUNCATE_LINES=0` disables truncation.
 *
 * Measured on nusagate/deepseek-v4.1-flash (M3, 2026-10-26): this is not a cost lever. The
 * upstream already compresses a multi-line `tool` message once it passes ~245 lines into a flat
 * budget (~2.2k tokens), so a 200-line cap lands just under that budget and is billed at full
 * rate: 100.5k vs 97.9k tokens over a fixed session (+2.7%), cost unchanged at Rp 22. A cap of 50
 * lines does save 15.4% of tokens, but it hides output the provider would otherwise have shown.
 * Kept on because it replaces the provider's silent middle-drop with an explicit `offset` pointer
 * the model can follow; pi itself already caps read/bash at 2000 lines / 50KB.
 * Upgrade: re-measure the threshold if the provider changes, and prefer 50 for a provider that
 * does not compress tool output at all.
 */
const MAX_LINES = Number(process.env.NUSACODE_TRUNCATE_LINES ?? 200);
const CACHE_WARNING = "cache prefix berubah, biaya input bisa naik ~10x";
const MECHANICAL = /\b(rename|ganti nama|ubah nama|replace|ganti string|ganti teks|ganti kata|find and replace|typo|sed -i)\b/i;

function linesOf(text: string): string[] {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n");
}

/** `read` has an `offset` argument, so the model can continue exactly where the cut happened. */
function truncateRead(text: string, offsetInput: unknown): string {
  const lines = linesOf(text);
  if (lines.length <= MAX_LINES) return text;
  const start = typeof offsetInput === "number" && offsetInput > 0 ? offsetInput : 1;
  const next = start + MAX_LINES;
  return `${lines.slice(0, MAX_LINES).join("\n")}\n\n[dipotong: ${MAX_LINES} dari ${lines.length} baris; lanjut: offset ${next}]`;
}

/**
 * `bash` has no offset argument, so keep the tail instead of the head: the exit status, the test
 * summary and pi's own "Full output: <path>" pointer all live at the end.
 */
function truncateBash(text: string): string {
  const lines = linesOf(text);
  if (lines.length <= MAX_LINES) return text;
  const hidden = lines.length - MAX_LINES;
  return `[dipotong: ${hidden} baris awal; menampilkan ${hidden + 1}-${lines.length} dari ${lines.length}]\n${lines.slice(-MAX_LINES).join("\n")}`;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const block = part as { type?: unknown; text?: unknown };
    if (block?.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

function systemText(payload: Record<string, unknown>): string {
  if (payload.system !== undefined) return textOfContent(payload.system);
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  for (const message of messages) {
    const entry = message as { role?: unknown; content?: unknown };
    if (entry?.role === "system" || entry?.role === "developer") return textOfContent(entry.content);
  }
  return "";
}

/**
 * Fingerprint of everything the provider caches as a prefix. The full tool JSON is hashed, not
 * just the names: a schema edit invalidates the cache exactly like a rename does.
 * ponytail: only system + tools, because conversation messages are append-only by construction.
 * Upgrade: include the first N message hashes if a provider starts rewriting history.
 */
function prefixFingerprint(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const tools = Array.isArray(record.tools) ? record.tools : [];
  const names = tools.map((tool) => {
    const entry = tool as { name?: unknown; function?: { name?: unknown } };
    if (typeof entry?.name === "string") return entry.name;
    return typeof entry?.function?.name === "string" ? entry.function.name : "?";
  });
  return createHash("sha256")
    .update(systemText(record))
    .update("\u0000")
    .update(names.join("\n"))
    .update("\u0000")
    .update(JSON.stringify(tools))
    .digest("hex")
    .slice(0, 16);
}

export default function tokenSaver(pi: ExtensionAPI) {
  if (process.env.NUSACODE_NO_TOKEN_SAVER === "1") return;

  let lastPrefix: string | null = null;
  let toolErrors = 0;
  let userChose = false;
  let lastTarget: string | null = null;

  pi.on("session_start", () => {
    lastPrefix = null;
    toolErrors = 0;
    userChose = false;
    lastTarget = null;
  });

  pi.on("tool_execution_end", (event) => {
    if (event.isError) toolErrors += 1;
  });

  // An explicit /think choice wins over routing for the rest of the session. Our own
  // setThinkingLevel below fires this same event, so ignore the echo of our own target.
  pi.on("thinking_level_select", (event) => {
    if (event.level !== lastTarget) userChose = true;
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType !== "user") return;
    if (userChose) return;
    const settings = pi.getSettings();
    const perModel = ctx.model
      ? settings.modelThinkingLevels?.[`${ctx.model.provider}/${ctx.model.id}`]
      : undefined;
    const configured = perModel ?? settings.defaultThinkingLevel ?? pi.getThinkingLevel();
    const current = pi.getThinkingLevel();
    const mechanical = toolErrors === 0 && current !== "off" && event.prompt.length <= 280 && MECHANICAL.test(event.prompt);
    const target = mechanical ? "minimal" : configured;
    if (target === current || target === lastTarget) return;
    lastTarget = target;
    pi.setThinkingLevel(target);
  });

  pi.on("tool_result", (event) => {
    if (MAX_LINES <= 0) return;
    if (event.isError) return;
    if (event.toolName !== "read" && event.toolName !== "bash") return;
    const block = event.content.length === 1 ? (event.content[0] as { type: string; text?: unknown }) : null;
    if (block?.type !== "text" || typeof block.text !== "string") return;
    const truncated =
      event.toolName === "read" ? truncateRead(block.text, event.input.offset) : truncateBash(block.text);
    if (truncated === block.text) return;
    return {
      content: [{ type: "text", text: truncated }],
      details: event.details,
      // Codemode callers keep the full payload; only the model-facing text is capped.
      structuredContent: event.structuredContent,
    };
  });

  pi.on("before_provider_request", (event, ctx) => {
    const fingerprint = prefixFingerprint(event.payload);
    if (fingerprint === null) return;
    const previous = lastPrefix;
    lastPrefix = fingerprint;
    if (previous === null || previous === fingerprint) return;
    ctx.ui.notify(CACHE_WARNING, "warning");
  });
}
