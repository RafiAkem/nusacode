/**
 * One relay room: one NusaCode session (the "agent") and the phones watching it ("viewers").
 *
 * The relay is deliberately dumb. Frames between agent and viewers are end-to-end encrypted
 * binary messages that it forwards without looking inside; the only things it understands
 * are who is connected and how much they are sending. It writes JSON text frames of its own
 * ({"r":"viewers","n":2} to the agent, {"r":"agent","up":true} to viewers) so each side knows
 * who is there.
 *
 * Built for Cloudflare's WebSocket Hibernation API: nothing is kept in memory between
 * messages, so an idle room costs no compute time. Per-socket state lives in the socket's
 * attachment and the agent's proof in storage.
 */
import type { DurableObjectState, RelaySocket } from "./types.d.ts";

export const MAX_MESSAGE_BYTES = 512 * 1024;
export const MAX_VIEWERS = 6;
export const IDLE_MS = 30 * 60 * 1000;
/** A socket may send this many messages at once, then this many per second. */
export const BURST = 40;
export const PER_SECOND = 10;

export type Role = "agent" | "viewer";

export type Attachment = { role: Role; tokens: number; at: number; lastMessage: number };

/** Takes one message's worth from the bucket, or returns undefined when it is empty. */
export function takeToken(attachment: Attachment, now: number): Attachment | undefined {
  const refilled = Math.min(BURST, attachment.tokens + ((now - attachment.at) / 1000) * PER_SECOND);
  if (refilled < 1) return undefined;
  return { ...attachment, tokens: refilled - 1, at: now };
}

export function parseRole(value: string | null): Role | undefined {
  return value === "agent" || value === "viewer" ? value : undefined;
}

const text = (message: unknown) => JSON.stringify(message);

export class RelayRoom {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    // Keepalive pings are answered by the platform without waking this object.
    const Pair = (globalThis as unknown as { WebSocketRequestResponsePair?: new (request: string, response: string) => unknown }).WebSocketRequestResponsePair;
    if (Pair) this.state.setWebSocketAutoResponse?.(new Pair("ping", "pong"));
  }

  private sockets(role: Role): RelaySocket[] {
    return this.state.getWebSockets(role);
  }

  private tell(sockets: RelaySocket[], message: unknown): void {
    for (const socket of sockets) {
      try {
        socket.send(text(message));
      } catch {
        // a socket that just closed; its close event cleans up
      }
    }
  }

  private announce(): void {
    const agents = this.sockets("agent");
    const viewers = this.sockets("viewer");
    this.tell(agents, { r: "viewers", n: viewers.length });
    this.tell(viewers, { r: "agent", up: agents.length > 0 });
  }

  async fetch(request: Request, platform: Platform = cloudflare): Promise<Response> {
    const url = new URL(request.url);
    const role = parseRole(url.searchParams.get("role"));
    if (!role) return new Response("Missing or bad role.\n", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket.\n", { status: 426 });

    if (role === "agent") {
      const proof = url.searchParams.get("proof") ?? "";
      if (proof.length < 16) return new Response("Missing proof.\n", { status: 400 });
      const known = await this.state.storage.get<string>("proof");
      if (known === undefined) await this.state.storage.put("proof", proof);
      else if (known !== proof) return new Response("This room belongs to another agent.\n", { status: 403 });
      // The real agent reconnecting replaces its earlier, probably dead, connection.
      for (const old of this.sockets("agent")) old.close(1000, "replaced");
    } else if (this.sockets("viewer").length >= MAX_VIEWERS) {
      return new Response("This session already has the most viewers it allows.\n", { status: 429 });
    }

    const { client, server } = platform.makePair();
    this.state.acceptWebSocket(server, [role]);
    const now = Date.now();
    server.serializeAttachment({ role, tokens: BURST, at: now, lastMessage: now } satisfies Attachment);
    await this.state.storage.setAlarm(now + IDLE_MS);
    this.announce();
    return platform.upgraded(client);
  }

  webSocketMessage(socket: RelaySocket, message: string | ArrayBuffer): void {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (!attachment) return socket.close(1011, "unknown socket");
    if (typeof message === "string") return; // phones and agents only send encrypted binary frames
    if (message.byteLength > MAX_MESSAGE_BYTES) return socket.close(1009, "message too large");
    const now = Date.now();
    const next = takeToken(attachment, now);
    if (!next) return socket.close(1008, "sending too fast");
    socket.serializeAttachment({ ...next, lastMessage: attachment.role === "agent" ? now : attachment.lastMessage } satisfies Attachment);
    for (const target of this.sockets(attachment.role === "agent" ? "viewer" : "agent")) {
      try {
        target.send(message);
      } catch {
        // closing; its close event cleans up
      }
    }
  }

  webSocketClose(socket: RelaySocket, code: number, reason: string): void {
    try {
      socket.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason.slice(0, 100));
    } catch {
      // already closed
    }
    this.announce();
  }

  webSocketError(socket: RelaySocket): void {
    try {
      socket.close(1011, "error");
    } catch {
      // already closed
    }
    this.announce();
  }

  /** Closes a room whose agent has gone quiet, and forgets it. */
  async alarm(): Promise<void> {
    const agents = this.sockets("agent");
    const now = Date.now();
    const quiet = agents.every((socket) => now - ((socket.deserializeAttachment() as Attachment | null)?.lastMessage ?? 0) >= IDLE_MS);
    if (agents.length === 0 || quiet) {
      for (const socket of [...agents, ...this.sockets("viewer")]) socket.close(1000, "session ended");
      await this.state.storage.deleteAll();
      return;
    }
    await this.state.storage.setAlarm(now + IDLE_MS);
  }
}

/** The two things the room needs from its host: a socket pair, and the response that hands one end over. */
export interface Platform {
  makePair(): { client: RelaySocket; server: RelaySocket };
  upgraded(client: RelaySocket): Response;
}

/** Cloudflare's own: a WebSocketPair and a 101 response. Only works inside Cloudflare. */
const cloudflare: Platform = {
  makePair() {
    const Pair = (globalThis as unknown as { WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket } }).WebSocketPair;
    const pair = new Pair();
    return { client: pair[0], server: pair[1] };
  },
  upgraded: (client) => new Response(null, { status: 101, webSocket: client } as ResponseInit),
};
