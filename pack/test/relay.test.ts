import { test } from "node:test";
import assert from "node:assert/strict";
import { Script, createContext } from "node:vm";
import { newKey, open, proofOf, randomId, seal, TO_AGENT, TO_VIEWER } from "../lib/relay-crypto.ts";
import { PAGE_CRYPTO, RELAY_PAGE } from "../lib/remote-page.ts";
import { applyUpdate, makeUpdate, UpdateStream } from "../lib/remote-sync.ts";
import type { Item, RemoteState } from "../lib/remote-state.ts";
import { normalizeRelayUrl, socketBase } from "../lib/relay-client.ts";
import { BURST, MAX_MESSAGE_BYTES, MAX_VIEWERS, PER_SECOND, RelayRoom, takeToken, type Attachment, type Platform } from "../../relay/src/room.ts";

// --- encryption --------------------------------------------------------------------------------

test("a message survives a round trip and is not readable in the frame", async () => {
  const key = newKey();
  const frame = await seal(key, TO_VIEWER, { t: "state", secret: "do not leak this" });
  assert.ok(!Buffer.from(frame).includes("do not leak this"));
  assert.deepEqual(await open(key, TO_VIEWER, frame), { t: "state", secret: "do not leak this" });
});

test("a frame is refused with the wrong key, the wrong direction, or any damage", async () => {
  const key = newKey();
  const frame = await seal(key, TO_AGENT, { t: "prompt", text: "hi" });
  assert.equal(await open(newKey(), TO_AGENT, frame), undefined);
  assert.equal(await open(key, TO_VIEWER, frame), undefined, "a phone's frame can't be passed off as the agent's");
  const damaged = frame.slice();
  damaged[damaged.length - 1] ^= 1;
  assert.equal(await open(key, TO_AGENT, damaged), undefined);
  assert.equal(await open(key, TO_AGENT, frame.slice(0, 20)), undefined);
  assert.equal(await open(key, TO_AGENT, new Uint8Array(0)), undefined);
});

test("every frame has a fresh IV, so identical messages look different", async () => {
  const key = newKey();
  const [a, b] = await Promise.all([seal(key, 1, { same: true }), seal(key, 1, { same: true })]);
  assert.notDeepEqual(a, b);
});

test("the proof lets the relay recognise the agent without being able to be it", async () => {
  assert.equal(await proofOf("secret"), await proofOf("secret"));
  assert.notEqual(await proofOf("secret"), await proofOf("other"));
  assert.ok(!(await proofOf("secret")).includes("secret"));
  assert.notEqual(randomId(), randomId());
});

/** The phone page's own copy of the crypto, run against the Node version. */
function pageCrypto() {
  const context = createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, Uint8Array, JSON });
  new Script(`${PAGE_CRYPTO}\nthis.seal = seal; this.open = open;`).runInContext(context);
  return context as unknown as { seal(key: string, direction: number, message: unknown): Promise<Uint8Array>; open(key: string, direction: number, frame: Uint8Array): Promise<unknown> };
}

test("the phone page and NusaCode read each other's frames", async () => {
  const page = pageCrypto();
  const key = newKey();
  assert.deepEqual(await page.open(key, TO_VIEWER, await seal(key, TO_VIEWER, { from: "agent" })), { from: "agent" });
  assert.deepEqual(await open(key, TO_AGENT, await page.seal(key, TO_AGENT, { from: "phone" })), { from: "phone" });
  assert.equal(await page.open(key, TO_VIEWER, await page.seal(key, TO_AGENT, { x: 1 })), undefined);
});

test("the relay page parses and carries the crypto and the reconnect logic", () => {
  const script = /<script nonce="__NONCE__">([\s\S]*?)<\/script>/.exec(RELAY_PAGE)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  for (const expected of ["location.hash.slice(1)", 'role=viewer', "session ended", "additionalData"]) assert.ok(script.includes(expected), expected);
  assert.ok(!RELAY_PAGE.includes("innerHTML"));
  assert.ok(!RELAY_PAGE.includes("/api/state"), "the relay page does not use the local server's API");
});

// --- updates -----------------------------------------------------------------------------------

const item = (text: string): Item => ({ kind: "assistant", text });
const state = (items: Item[], over: Partial<RemoteState> = {}): RemoteState => ({ items, live: [], running: false, busyWith: undefined, model: "m", cwd: "c", sessionName: undefined, ...over });

test("an update carries only what changed since the last one", () => {
  const before = [item("a"), item("b"), item("c")];
  const after = [item("a"), item("b2"), item("c"), item("d")];
  const update = makeUpdate(before, state(after));
  assert.equal(update.from, 1);
  assert.deepEqual(update.items, [item("b2"), item("c"), item("d")]);
  assert.deepEqual(applyUpdate(before, update).items, after);
});

test("with nothing sent yet, or a shorter session, the update still rebuilds correctly", () => {
  assert.equal(makeUpdate(undefined, state([item("a")])).from, 0);
  const shorter = makeUpdate([item("a"), item("b")], state([item("a")]));
  assert.deepEqual(applyUpdate([item("a"), item("b")], shorter).items, [item("a")]);
});

test("the stream sends the first update whole, then small ones, and a reset starts over", () => {
  const stream = new UpdateStream();
  const items = [item("a"), item("b")];
  assert.equal(stream.next(state(items)).items.length, 2);
  const second = stream.next(state([...items, item("c")]));
  assert.deepEqual([second.from, second.items.length], [2, 1]);
  stream.reset();
  assert.equal(stream.next(state(items)).from, 0);
});

// --- the room ----------------------------------------------------------------------------------

class FakeSocket {
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  tags: string[] = [];
  attachment: unknown = null;
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown) {
    this.attachment = value;
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

function fakeRoom() {
  const sockets: FakeSocket[] = [];
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const state = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      setAlarm: async (time: number) => void (alarm = time),
      deleteAll: async () => store.clear(),
    },
    acceptWebSocket: (socket: FakeSocket, tags: string[] = []) => {
      socket.tags = tags;
      sockets.push(socket);
    },
    getWebSockets: (tag?: string) => sockets.filter((s) => !s.closed && (!tag || s.tags.includes(tag))),
  };
  const platform: Platform = {
    makePair: () => ({ client: new FakeSocket() as never, server: new FakeSocket() as never }),
    upgraded: () => ({ status: 101 }) as unknown as Response,
  };
  const room = new RelayRoom(state as never);
  const connect = async (query: string) =>
    room.fetch(new Request(`https://relay.test/ws/abc?${query}`, { headers: { Upgrade: "websocket" } }), platform) as Promise<{ status: number }>;
  return { room, sockets, store, connect, alarm: () => alarm };
}

const PROOF = "p".repeat(32);

test("takeToken allows a burst, then a steady rate, then refuses", () => {
  let attachment: Attachment = { role: "viewer", tokens: BURST, at: 0, lastMessage: 0 };
  for (let i = 0; i < BURST; i++) {
    const next = takeToken(attachment, 0);
    assert.ok(next, `message ${i}`);
    attachment = next;
  }
  assert.equal(takeToken(attachment, 0), undefined, "burst used up");
  assert.ok(takeToken(attachment, 1000 / PER_SECOND + 1), "one more after a short wait");
});

test("a room needs a real role and a WebSocket request", async () => {
  const { room, connect } = fakeRoom();
  assert.equal((await connect("role=hacker")).status, 400);
  assert.equal((await connect("role=agent&proof=short")).status, 400);
  assert.equal((await room.fetch(new Request("https://relay.test/ws/abc?role=viewer"))).status, 426);
});

test("the first agent claims the room; another agent with a different proof is refused", async () => {
  const { connect, sockets, store } = fakeRoom();
  assert.equal((await connect(`role=agent&proof=${PROOF}`)).status, 101);
  assert.equal(store.get("proof"), PROOF);
  assert.equal((await connect(`role=agent&proof=${"q".repeat(32)}`)).status, 403);
  assert.equal(sockets.length, 1);
});

test("the same agent reconnecting replaces its old connection", async () => {
  const { connect, sockets } = fakeRoom();
  await connect(`role=agent&proof=${PROOF}`);
  await connect(`role=agent&proof=${PROOF}`);
  assert.deepEqual(sockets[0].closed, { code: 1000, reason: "replaced" });
  assert.equal(sockets[1].closed, null);
});

test("viewers are limited per room", async () => {
  const { connect } = fakeRoom();
  for (let i = 0; i < MAX_VIEWERS; i++) assert.equal((await connect("role=viewer")).status, 101);
  assert.equal((await connect("role=viewer")).status, 429);
});

test("each side is told who is connected", async () => {
  const { connect, sockets } = fakeRoom();
  await connect(`role=agent&proof=${PROOF}`);
  await connect("role=viewer");
  const [agent, viewer] = sockets;
  assert.equal(agent.sent.at(-1), JSON.stringify({ r: "viewers", n: 1 }));
  assert.equal(viewer.sent.at(-1), JSON.stringify({ r: "agent", up: true }));
});

test("frames go from the agent to every viewer and from a viewer to the agent, unread", async () => {
  const { room, connect, sockets } = fakeRoom();
  await connect(`role=agent&proof=${PROOF}`);
  await connect("role=viewer");
  await connect("role=viewer");
  const [agent, one, two] = sockets;
  const down = new Uint8Array([1, 2, 3]).buffer;
  room.webSocketMessage(agent as never, down);
  assert.equal(one.sent.at(-1), down);
  assert.equal(two.sent.at(-1), down);
  const up = new Uint8Array([9, 9]).buffer;
  room.webSocketMessage(one as never, up);
  assert.equal(agent.sent.at(-1), up);
  assert.notEqual(two.sent.at(-1), up, "a phone's message is not shown to other phones");
});

test("text frames from clients are ignored, and oversized or too-fast senders are cut off", async () => {
  const { room, connect, sockets } = fakeRoom();
  await connect(`role=agent&proof=${PROOF}`);
  await connect("role=viewer");
  const [agent, viewer] = sockets;
  const before = agent.sent.length;
  room.webSocketMessage(viewer as never, "hello");
  assert.equal(agent.sent.length, before);
  room.webSocketMessage(viewer as never, new ArrayBuffer(MAX_MESSAGE_BYTES + 1));
  assert.equal(viewer.closed?.code, 1009);
  const { room: room2, connect: connect2, sockets: sockets2 } = fakeRoom();
  await connect2("role=viewer");
  for (let i = 0; i < BURST + 5; i++) room2.webSocketMessage(sockets2[0] as never, new ArrayBuffer(4));
  assert.equal(sockets2[0].closed?.code, 1008);
});

test("when the agent leaves the phones are told, and an idle room is shut down", async () => {
  const { room, connect, sockets, store, alarm } = fakeRoom();
  await connect(`role=agent&proof=${PROOF}`);
  await connect("role=viewer");
  const [agent, viewer] = sockets;
  assert.ok(alarm() !== null, "an idle timer is set when someone connects");
  agent.close(1000, "bye");
  room.webSocketClose(agent as never, 1000, "bye");
  assert.equal(viewer.sent.at(-1), JSON.stringify({ r: "agent", up: false }));
  await room.alarm();
  assert.equal(viewer.closed?.reason, "session ended");
  assert.equal(store.size, 0, "the room forgets everything");
});

test("an agent that is still active keeps the room open", async () => {
  const { room, connect, sockets, alarm } = fakeRoom();
  await connect(`role=agent&proof=${PROOF}`);
  const before = alarm();
  room.webSocketMessage(sockets[0] as never, new ArrayBuffer(4));
  await room.alarm();
  assert.equal(sockets[0].closed, null);
  assert.ok((alarm() ?? 0) >= (before ?? 0));
});

test("relay addresses must be https, or http on this computer", () => {
  assert.equal(normalizeRelayUrl("https://relay.example.dev/"), "https://relay.example.dev");
  assert.equal(normalizeRelayUrl(" https://relay.example.dev/some/path "), "https://relay.example.dev");
  assert.equal(normalizeRelayUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(normalizeRelayUrl("http://relay.example.dev"), undefined);
  assert.equal(normalizeRelayUrl("javascript:alert(1)"), undefined);
  assert.equal(normalizeRelayUrl("nonsense"), undefined);
  assert.equal(socketBase("https://relay.example.dev"), "wss://relay.example.dev");
  assert.equal(socketBase("http://127.0.0.1:8787"), "ws://127.0.0.1:8787");
});
