import { test } from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { startDevRelay, type DevRelay } from "../../relay/dev-server.ts";
import { open, seal, TO_AGENT, TO_VIEWER } from "../lib/relay-crypto.ts";
import { startRelayLink, type RelayLink } from "../lib/relay-client.ts";
import { applyUpdate, type Update } from "../lib/remote-sync.ts";
import type { Item, RemoteState } from "../lib/remote-state.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | undefined | false, what: string, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** NusaCode's side, with a controllable session. */
function agentSide(relay: DevRelay) {
  const session = { items: [{ kind: "user", text: "hello" }] as Item[], running: false };
  const calls = { prompts: [] as string[], aborts: 0 };
  const state = (): RemoteState => ({ items: session.items, live: [], running: session.running, busyWith: undefined, model: "DeepSeek", cwd: "nusacode", sessionName: "demo" });
  return {
    session,
    calls,
    start: () =>
      startRelayLink({
        relayUrl: relay.url,
        throttleMs: 15,
        handlers: { state, prompt: (text) => calls.prompts.push(text), abort: () => calls.aborts++ },
      }),
  };
}

/** A phone: what the page does, minus the drawing. */
async function phone(link: string) {
  const { pathname, hash, origin } = new URL(link);
  const sid = pathname.split("/").pop()!;
  const key = hash.slice(1);
  const ws = new WebSocket(`${origin.replace("http", "ws")}/ws/${sid}?role=viewer`);
  ws.binaryType = "arraybuffer";
  const seen = { controls: [] as unknown[], updates: [] as Update[], frames: [] as Uint8Array[], items: [] as Item[], latest: undefined as RemoteState | undefined };
  ws.onmessage = async (event) => {
    if (typeof event.data === "string") return void seen.controls.push(JSON.parse(event.data));
    seen.frames.push(new Uint8Array(event.data));
    const message = (await open(key, TO_VIEWER, event.data)) as Update | undefined;
    if (message?.t === "state") {
      seen.updates.push(message);
      seen.latest = applyUpdate(seen.items, message);
      seen.items = seen.latest.items;
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("phone could not connect"));
  });
  const vid = "phone-1";
  let seq = 0;
  const raw: Uint8Array[] = [];
  return {
    seen,
    raw,
    ws,
    async send(message: object) {
      const frame = await seal(key, TO_AGENT, { vid, seq: ++seq, ...message });
      raw.push(frame);
      ws.send(frame);
    },
    resend: (frame: Uint8Array) => ws.send(frame),
    close: () => ws.close(),
  };
}

async function withRelay(run: (relay: DevRelay) => Promise<void>) {
  const relay = await startDevRelay(0);
  try {
    await run(relay);
  } finally {
    await relay.close();
  }
}

test("a phone gets the session, sends a message, and a replayed message is ignored", async () => {
  await withRelay(async (relay) => {
    const agent = agentSide(relay);
    const link: RelayLink = await agent.start();
    try {
      assert.match(link.link, /^http:\/\/127\.0\.0\.1:\d+\/s\/[\w-]{20,}#[\w-]{40,}$/);
      const p = await phone(link.link);
      const first = await until(() => p.seen.latest, "the first update");
      assert.deepEqual(first.items, [{ kind: "user", text: "hello" }]);
      assert.deepEqual([first.model, first.sessionName], ["DeepSeek", "demo"]);
      assert.equal(link.viewers(), 1);

      // The agent changes something; the phone gets a small update.
      agent.session.items = [...agent.session.items, { kind: "assistant", text: "hi there" }];
      agent.session.running = true;
      link.notify();
      await until(() => p.seen.latest?.running, "the running update");
      assert.equal(p.seen.updates.at(-1)!.from, 1, "only the new item was sent");
      assert.deepEqual(p.seen.latest!.items.at(-1), { kind: "assistant", text: "hi there" });

      // The phone sends a message, and stops the agent.
      await p.send({ t: "prompt", text: "  keep going  " });
      await until(() => agent.calls.prompts.length === 1, "the prompt");
      assert.deepEqual(agent.calls.prompts, ["keep going"]);
      await p.send({ t: "abort" });
      await until(() => agent.calls.aborts === 1, "the abort");

      // A copy of the first message sent again does nothing.
      p.resend(p.raw[0]);
      await wait(150);
      assert.equal(agent.calls.prompts.length, 1);

      // The relay only ever saw ciphertext.
      for (const frame of p.seen.frames) assert.ok(!Buffer.from(frame).includes("hi there"));
      p.close();
    } finally {
      link.close();
    }
  });
});

test("a phone that joins late is brought up to date with everything", async () => {
  await withRelay(async (relay) => {
    const agent = agentSide(relay);
    agent.session.items = Array.from({ length: 5 }, (_, i) => ({ kind: "assistant", text: `line ${i}` }) as Item);
    const link = await agent.start();
    try {
      const one = await phone(link.link);
      await until(() => one.seen.latest, "first phone");
      const two = await phone(link.link);
      const latest = await until(() => two.seen.latest, "second phone");
      assert.equal(latest.items.length, 5);
      assert.equal(two.seen.updates[0].from, 0, "the newcomer got the whole session");
      assert.equal(link.viewers(), 2);
      one.close();
      two.close();
    } finally {
      link.close();
    }
  });
});

test("nothing is built or sent while no phone is watching", async () => {
  await withRelay(async (relay) => {
    let builds = 0;
    const link = await startRelayLink({
      relayUrl: relay.url,
      throttleMs: 10,
      handlers: { state: () => (builds++, { items: [], live: [], running: false, busyWith: undefined, model: "", cwd: "", sessionName: undefined }), prompt() {}, abort() {} },
    });
    try {
      await until(() => link.connected(), "the connection");
      for (let i = 0; i < 5; i++) link.notify();
      await wait(120);
      assert.equal(builds, 0);
    } finally {
      link.close();
    }
  });
});

test("a different agent cannot take over a room, and a phone can't pose as the agent", async () => {
  await withRelay(async (relay) => {
    const agent = agentSide(relay);
    const link = await agent.start();
    try {
      const sid = new URL(link.link).pathname.split("/").pop();
      await until(() => link.connected(), "the connection");
      const intruder = new WebSocket(`${relay.url.replace("http", "ws")}/ws/${sid}?role=agent&proof=${"z".repeat(43)}`);
      const result = await new Promise<string>((resolve) => {
        intruder.onopen = () => resolve("opened");
        intruder.onerror = () => resolve("refused");
        intruder.onclose = () => resolve("refused");
      });
      assert.equal(result, "refused");
      assert.ok(link.connected(), "the real agent is still connected");

      // A phone with the wrong key is ignored by the agent.
      const rogue = await phone(link.link.replace(/#.*/, `#${"A".repeat(43)}`));
      await rogue.send({ t: "prompt", text: "rm -rf /" });
      await wait(150);
      assert.deepEqual(agent.calls.prompts, []);
      rogue.close();
    } finally {
      link.close();
    }
  });
});

test("the relay serves the phone page and nothing else of note", async () => {
  await withRelay(async (relay) => {
    const sid = "A".repeat(22);
    const page = await fetch(`${relay.url}/s/${sid}`);
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.ok(csp.includes(`connect-src 'self' wss://${new URL(relay.url).host}`));
    const body = await page.text();
    assert.ok(body.includes("NusaCode remote") && !body.includes("__NONCE__"));
    assert.equal((await fetch(`${relay.url}/`)).status, 200);
    assert.equal((await fetch(`${relay.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${relay.url}/s/short`)).status, 404);
    assert.equal((await fetch(`${relay.url}/api/state`)).status, 404);
    // A browser page from another site may not open a phone connection.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${relay.url}/ws/${sid}?role=viewer`, {
        headers: { Origin: "https://evil.example", Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("upgrade", () => resolve(101));
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

test("closing the link disconnects from the relay", async () => {
  await withRelay(async (relay) => {
    const agent = agentSide(relay);
    const link = await agent.start();
    const p = await phone(link.link);
    await until(() => p.seen.latest, "an update");
    link.close();
    await until(() => p.seen.controls.some((c) => (c as { r?: string; up?: boolean }).r === "agent" && (c as { up?: boolean }).up === false), "the phone to hear the agent left");
    p.close();
  });
});

type Handler = (event: any, ctx: any) => any;

test("/remote relay saves the address, connects, shows the link and QR, and relays a phone's message", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: remote } = await import("../extensions/remote.ts");
  const home = mkdtempSync(join(tmpdir(), "nusacode-remote-"));
  const previous = { dir: process.env.NUSACODE_CODING_AGENT_DIR, url: process.env.NUSACODE_RELAY_URL };
  process.env.NUSACODE_CODING_AGENT_DIR = home;
  delete process.env.NUSACODE_RELAY_URL;
  try {
    await withRelay(async (relay) => {
      const handlers = new Map<string, Handler>();
      let command: ((args: string, ctx: any) => Promise<void>) | undefined;
      const sent: unknown[][] = [];
      const notes: string[] = [];
      const statuses: (string | undefined)[] = [];
      remote({
        registerFlag() {},
        registerCommand: (_name: string, options: { handler: typeof command }) => (command = options.handler),
        on: (name: string, handler: Handler) => handlers.set(name, handler),
        getFlag: () => false,
        sendUserMessage: (...args: unknown[]) => sent.push(args),
      } as never);
      const ctx = {
        mode: "tui",
        cwd: "C:/work/nusacode",
        model: { name: "DeepSeek V4.1 Flash" },
        isIdle: () => true,
        abort() {},
        sessionManager: { getEntries: () => [{ type: "message", message: { role: "user", content: "hi from the terminal" } }], getSessionName: () => "demo" },
        ui: { notify: (text: string) => notes.push(text), setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
      };
      handlers.get("session_start")!({}, ctx);

      await command!("relay", ctx);
      assert.match(notes[0], /No relay is set up yet/);
      await command!("relay not-a-url", ctx);
      assert.match(notes[1], /not a usable relay address/);

      await command!(`relay ${relay.url}`, ctx);
      const link = /(http:\/\/127\.0\.0\.1:\d+\/s\/[\w-]+#[\w-]+)/.exec(notes[2])?.[1];
      assert.ok(link, notes[2]);
      assert.ok(notes[2].includes("▀") && notes[2].includes("end-to-end encrypted"));
      assert.equal(JSON.parse(readFileSync(join(home, "remote.json"), "utf8")).relay, relay.url, "the address is remembered");

      const p = await phone(link);
      const first = await until(() => p.seen.latest, "the session on the phone");
      assert.equal((first.items[0] as { text: string }).text, "hi from the terminal");
      assert.ok(statuses.some((status) => status?.includes("1 watching")), `status bar: ${statuses.join(" | ")}`);
      await p.send({ t: "prompt", text: "from my phone" });
      await until(() => sent.length === 1, "the message to reach pi");
      assert.deepEqual(sent[0], ["from my phone", undefined], "sent straight away because the agent is idle");

      // With the address saved, plain /remote picks the relay on its own.
      await command!("stop", ctx);
      assert.match(notes.at(-1)!, /stopped/);
      await command!("", ctx);
      assert.match(notes.at(-1)!, /through the relay/);
      await command!("stop", ctx);
      p.close();
    });
  } finally {
    if (previous.dir === undefined) delete process.env.NUSACODE_CODING_AGENT_DIR;
    else process.env.NUSACODE_CODING_AGENT_DIR = previous.dir;
    if (previous.url !== undefined) process.env.NUSACODE_RELAY_URL = previous.url;
    rmSync(home, { recursive: true, force: true });
  }
});
