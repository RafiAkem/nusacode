/**
 * NusaCode's side of the relay: connect out, keep the phone's view current, take its orders.
 *
 * Nothing listens on this computer. A session is a random id plus a random key; the link
 * puts the id in the path and the key after the #, so the relay learns the id and never the
 * key. Updates are only built and sent while at least one phone is connected.
 *
 * What a phone may do is exactly what the local page may do: send a message, stop the agent,
 * or ask for the whole state again. Each phone numbers its messages, and anything not newer
 * than the last one seen is dropped, so a copy replayed by a misbehaving relay does nothing.
 */
import { newKey, open, proofOf, randomId, seal, TO_AGENT, TO_VIEWER } from "./relay-crypto.ts";
import { UpdateStream } from "./remote-sync.ts";
import type { RemoteState } from "./remote-state.ts";

export type RelayHandlers = {
  state(): RemoteState;
  prompt(text: string): void;
  abort(): void;
};

export type RelayLink = {
  /** What to open on the phone, and what the QR code holds. */
  link: string;
  /** Tell the relay the session changed; bursts are sent as one update. */
  notify(): void;
  viewers(): number;
  connected(): boolean;
  close(): void;
};

type SocketLike = {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;
const MAX_FRAME = 480 * 1024;
const MAX_PROMPT = 20_000;
const KEEPALIVE_MS = 30_000;
const MAX_PHONES_REMEMBERED = 64;

/** https://host/ becomes wss://host, and http becomes ws (for a relay running on this computer). */
export function socketBase(relayUrl: string): string {
  const url = new URL(relayUrl);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
}

export function normalizeRelayUrl(input: string): string | undefined {
  try {
    const url = new URL(input.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

export async function startRelayLink(options: {
  relayUrl: string;
  handlers: RelayHandlers;
  /** Defaults to the WebSocket built into Node. */
  createSocket?: SocketFactory;
  /** How long to gather changes into one update. */
  throttleMs?: number;
  onChange?: () => void;
}): Promise<RelayLink> {
  const base = normalizeRelayUrl(options.relayUrl);
  if (!base) throw new Error(`"${options.relayUrl}" is not a usable relay address. Use an https:// address.`);

  const sid = randomId(16);
  const key = newKey();
  const proof = await proofOf(randomId(24));
  const link = `${base}/s/${sid}#${key}`;
  const stream = new UpdateStream();
  const lastSeq = new Map<string, number>();
  const createSocket: SocketFactory = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  const throttle = options.throttleMs ?? 300;

  let socket: SocketLike | null = null;
  let closed = false;
  let phones = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<void> = Promise.resolve();
  let keepalive: ReturnType<typeof setInterval> | null = null;

  /** Builds and sends an update, one at a time so the diffs arrive in order. */
  function push(): void {
    queue = queue.then(async () => {
      if (closed || !socket || socket.readyState !== OPEN || phones === 0) return;
      const frame = await seal(key, TO_VIEWER, stream.next(options.handlers.state()));
      if (frame.byteLength > MAX_FRAME) {
        stream.reset(); // too big for the relay; the next, smaller change starts afresh
        return;
      }
      if (socket && socket.readyState === OPEN) socket.send(frame);
    }).catch(() => undefined);
  }

  function schedule(): void {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      push();
    }, throttle);
    timer.unref?.();
  }

  async function onPhoneMessage(data: unknown): Promise<void> {
    const bytes = data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? (data.buffer as ArrayBuffer) : undefined;
    if (!bytes) return;
    const message = (await open(key, TO_AGENT, bytes)) as { t?: unknown; vid?: unknown; seq?: unknown; text?: unknown } | undefined;
    if (!message || typeof message.vid !== "string" || typeof message.seq !== "number") return;
    if (message.seq <= (lastSeq.get(message.vid) ?? 0)) return; // a replay, or out of order
    lastSeq.set(message.vid, message.seq);
    if (lastSeq.size > MAX_PHONES_REMEMBERED) lastSeq.delete(lastSeq.keys().next().value as string);

    if (message.t === "sync") {
      stream.reset();
      push();
    } else if (message.t === "prompt" && typeof message.text === "string" && message.text.trim()) {
      options.handlers.prompt(message.text.trim().slice(0, MAX_PROMPT));
    } else if (message.t === "abort") {
      options.handlers.abort();
    }
  }

  function connect(): void {
    if (closed) return;
    const ws = createSocket(`${socketBase(base!)}/ws/${sid}?role=agent&proof=${proof}`);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      failures = 0;
      stream.reset();
      options.onChange?.();
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const info = JSON.parse(event.data) as { r?: string; n?: number };
          if (info.r === "viewers" && typeof info.n === "number") {
            const grew = info.n > phones;
            phones = info.n;
            if (grew) {
              stream.reset();
              push();
            }
            options.onChange?.();
          }
        } catch {
          // not a control frame
        }
        return;
      }
      void onPhoneMessage(event.data);
    };
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (socket === ws) socket = null;
      phones = 0;
      options.onChange?.();
      if (closed) return;
      failures += 1;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
      const retry = setTimeout(connect, wait);
      retry.unref?.();
    };
  }

  connect();
  keepalive = setInterval(() => {
    if (socket && socket.readyState === OPEN) socket.send("ping");
  }, KEEPALIVE_MS);
  keepalive.unref?.();

  return {
    link,
    notify: schedule,
    viewers: () => phones,
    connected: () => socket?.readyState === OPEN,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (keepalive) clearInterval(keepalive);
      socket?.close(1000, "closed");
      socket = null;
    },
  };
}
