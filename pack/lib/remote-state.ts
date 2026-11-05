/**
 * What the remote page shows: the session reduced to a flat list of small, JSON-safe items.
 * Everything the model said or ran is untrusted text; the page only ever sets it as text.
 */

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; target: string }
  | { kind: "result"; id: string; name: string; isError: boolean; text: string };

export type RemoteState = {
  items: Item[];
  /** The assistant message that is still streaming, if any. */
  live: Item[];
  running: boolean;
  busyWith: string | undefined;
  model: string;
  cwd: string;
  sessionName: string | undefined;
};

const MAX_ITEMS = 200;
const MAX_RESULT = 600;
const MAX_TEXT = 20_000;

type Block = { type?: string; text?: string; name?: string; id?: string; arguments?: unknown };
type MessageLike = { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };

function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(content: unknown): string {
  const blocks = blocksOf(content);
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  const images = blocks.filter((b) => b.type === "image").length;
  return [text, images ? `[${images} image${images === 1 ? "" : "s"}]` : ""].filter(Boolean).join("\n");
}

/** The thing a tool call works on: its path, command or pattern, on one line. */
export function targetOf(args: unknown): string {
  const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "prompt", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return "";
}

/** One session message as items. Thinking blocks are left out. */
export function itemsOf(message: MessageLike | undefined): Item[] {
  if (!message) return [];
  if (message.role === "user") {
    const text = textOf(message.content);
    return text ? [{ kind: "user", text: text.slice(0, MAX_TEXT) }] : [];
  }
  if (message.role === "toolResult") {
    return [{ kind: "result", id: message.toolCallId ?? "", name: message.toolName ?? "tool", isError: message.isError === true, text: textOf(message.content).slice(0, MAX_RESULT) }];
  }
  if (message.role === "assistant") {
    return blocksOf(message.content).flatMap((block): Item[] => {
      if (block.type === "text" && block.text?.trim()) return [{ kind: "assistant", text: block.text.slice(0, MAX_TEXT) }];
      if (block.type === "toolCall") return [{ kind: "tool", id: block.id ?? "", name: block.name ?? "tool", target: targetOf(block.arguments) }];
      return [];
    });
  }
  return [];
}

export function buildState(input: {
  entries: { type: string; message?: MessageLike }[];
  live: MessageLike | undefined;
  running: boolean;
  busyWith: string | undefined;
  model: string;
  cwd: string;
  sessionName: string | undefined;
}): RemoteState {
  const items = input.entries.flatMap((entry) => (entry.type === "message" ? itemsOf(entry.message) : []));
  return {
    items: items.slice(-MAX_ITEMS),
    live: itemsOf(input.live),
    running: input.running,
    busyWith: input.busyWith,
    model: input.model,
    cwd: input.cwd,
    sessionName: input.sessionName,
  };
}
