import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { REMOTE_PAGE } from "../lib/remote-page.ts";
import { startRemoteServer, type RemoteServer } from "../lib/remote-server.ts";
import { buildState, itemsOf, targetOf } from "../lib/remote-state.ts";
import remote from "../extensions/remote.ts";

const TOKEN = "test-token-123";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** A raw request, so tests can set headers like Origin that fetch refuses to. */
function call(server: RemoteServer, method: string, path: string, options: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, method, path, headers: options.headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

async function withServer(run: (server: RemoteServer, seen: { prompts: string[]; aborts: number }) => Promise<void>) {
  const seen = { prompts: [] as string[], aborts: 0 };
  const server = await startRemoteServer({
    page: REMOTE_PAGE,
    token: TOKEN,
    handlers: { state: () => ({ hello: "world" }), prompt: (text) => seen.prompts.push(text), abort: () => seen.aborts++ },
  });
  try {
    await run(server, seen);
  } finally {
    await server.close();
  }
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const json = { "Content-Type": "application/json" };

test("nothing is served without the token", async () => {
  await withServer(async (server) => {
    for (const path of ["/", "/api/state", "/api/events"]) assert.equal((await call(server, "GET", path)).status, 401, path);
    assert.equal((await call(server, "GET", "/api/state", { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await call(server, "GET", "/api/state", { headers: { Authorization: "Bearer x" } })).status, 401, "a different length token is refused too");
    assert.equal((await call(server, "POST", "/api/prompt", { headers: json, body: '{"text":"hi"}' })).status, 401);
  });
});

test("the landing link swaps the token for a cookie and leaves it out of the URL", async () => {
  await withServer(async (server) => {
    const landing = await call(server, "GET", `/?token=${TOKEN}`);
    assert.equal(landing.status, 302);
    assert.equal(landing.headers.location, "/");
    const cookie = String(landing.headers["set-cookie"]);
    assert.match(cookie, /nsc_remote=test-token-123; HttpOnly; SameSite=Strict/);
    const page = await call(server, "GET", "/", { headers: { Cookie: cookie.split(";")[0] } });
    assert.equal(page.status, 200);
    assert.match(page.body, /NusaCode remote/);
    assert.equal((await call(server, "GET", "/?token=nope")).status, 401);
  });
});

test("the page gets a fresh nonce and a policy that allows only its own script", async () => {
  await withServer(async (server) => {
    const one = await call(server, "GET", "/", { headers: { Cookie: `nsc_remote=${TOKEN}` } });
    const two = await call(server, "GET", "/", { headers: { Cookie: `nsc_remote=${TOKEN}` } });
    const nonce = /nonce-([^']+)'/.exec(String(one.headers["content-security-policy"]))?.[1];
    assert.ok(nonce && one.body.includes(`nonce="${nonce}"`));
    assert.ok(!one.body.includes("__NONCE__"));
    assert.notEqual(nonce, /nonce-([^']+)'/.exec(String(two.headers["content-security-policy"]))?.[1]);
    assert.match(String(one.headers["content-security-policy"]), /default-src 'none'/);
    assert.match(String(one.headers["content-security-policy"]), /frame-ancestors 'none'/);
  });
});

test("the page makes no outside requests and never writes session text as HTML", () => {
  assert.ok(!/https?:\/\//.test(REMOTE_PAGE.replace("http://www.w3.org", "")), "no external URLs");
  assert.ok(!REMOTE_PAGE.includes("innerHTML"));
});

test("state, prompt and abort work with a bearer token", async () => {
  await withServer(async (server, seen) => {
    assert.deepEqual(JSON.parse((await call(server, "GET", "/api/state", { headers: auth })).body), { hello: "world" });
    assert.equal((await call(server, "POST", "/api/prompt", { headers: { ...auth, ...json }, body: '{"text":"  fix the bug  "}' })).status, 200);
    assert.deepEqual(seen.prompts, ["fix the bug"]);
    assert.equal((await call(server, "POST", "/api/abort", { headers: auth })).status, 200);
    assert.equal(seen.aborts, 1);
  });
});

test("a bad prompt body is refused", async () => {
  await withServer(async (server, seen) => {
    for (const body of ["", "not json", "{}", '{"text":"   "}', '{"text":5}']) {
      assert.equal((await call(server, "POST", "/api/prompt", { headers: { ...auth, ...json }, body })).status, 400, body);
    }
    assert.deepEqual(seen.prompts, []);
  });
});

test("a request from another website is refused even with the token", async () => {
  await withServer(async (server, seen) => {
    const host = `127.0.0.1:${server.port}`;
    const evil = await call(server, "POST", "/api/prompt", { headers: { ...auth, ...json, Host: host, Origin: "https://evil.example" }, body: '{"text":"rm -rf"}' });
    assert.equal(evil.status, 403);
    assert.equal((await call(server, "POST", "/api/abort", { headers: { ...auth, Host: host, Origin: "https://evil.example" } })).status, 403);
    const same = await call(server, "POST", "/api/prompt", { headers: { ...auth, ...json, Host: host, Origin: `http://${host}` }, body: '{"text":"ok"}' });
    assert.equal(same.status, 200);
    assert.deepEqual(seen.prompts, ["ok"]);
  });
});

test("an oversized body is dropped", async () => {
  await withServer(async (server, seen) => {
    const big = JSON.stringify({ text: "x".repeat(100 * 1024) });
    await call(server, "POST", "/api/prompt", { headers: { ...auth, ...json }, body: big }).catch(() => undefined);
    assert.deepEqual(seen.prompts, []);
  });
});

test("connected pages hear about changes", async () => {
  await withServer(async (server) => {
    const received = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.port, path: "/api/events", headers: auth }, (res) => {
        assert.equal(res.headers["content-type"], "text/event-stream");
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
          if (text.includes('"changed"')) resolve(text);
        });
        setTimeout(() => server.notify(), 50);
      });
      req.on("error", reject);
      req.end();
    });
    assert.match(received, /data: \{"type":"changed"\}/);
  });
});

test("the server only listens on localhost and names a link with the token", async () => {
  await withServer(async (server) => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=test-token-123$/);
  });
});

test("itemsOf flattens messages and leaves thinking out", () => {
  assert.deepEqual(itemsOf({ role: "user", content: "hello" }), [{ kind: "user", text: "hello" }]);
  assert.deepEqual(itemsOf({ role: "user", content: [{ type: "text", text: "see" }, { type: "image" }] }), [{ kind: "user", text: "see\n[1 image]" }]);
  assert.deepEqual(
    itemsOf({ role: "assistant", content: [{ type: "thinking", text: "secret plan" }, { type: "text", text: "Done." }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }] }),
    [{ kind: "assistant", text: "Done." }, { kind: "tool", id: "t1", name: "read", target: "a.ts" }],
  );
  assert.deepEqual(itemsOf({ role: "toolResult", toolCallId: "t1", toolName: "read", isError: true, content: [{ type: "text", text: "boom" }] }), [
    { kind: "result", id: "t1", name: "read", isError: true, text: "boom" },
  ]);
  assert.deepEqual(itemsOf({ role: "system" }), []);
  assert.deepEqual(itemsOf(undefined), []);
});

test("targetOf picks one short line", () => {
  assert.equal(targetOf({ command: "npm  test\n -- x" }), "npm test -- x");
  assert.equal(targetOf({ path: "x".repeat(500) }).length, 200);
  assert.equal(targetOf(null), "");
});

test("buildState keeps the latest items, the streaming message and the session facts", () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({ type: "message", message: { role: "user", content: `m${i}` } }));
  const state = buildState({
    entries: [{ type: "custom" }, ...entries],
    live: { role: "assistant", content: [{ type: "text", text: "typing" }] },
    running: true,
    busyWith: "read a.ts",
    model: "DeepSeek",
    cwd: "nusacode",
    sessionName: "demo",
  });
  assert.equal(state.items.length, 200);
  assert.deepEqual(state.items.at(-1), { kind: "user", text: "m249" });
  assert.deepEqual(state.live, [{ kind: "assistant", text: "typing" }]);
  assert.deepEqual([state.running, state.busyWith, state.model, state.sessionName], [true, "read a.ts", "DeepSeek", "demo"]);
});

type Handler = (event: any, ctx: any) => any;

test("the extension starts on /remote, relays prompts and stops again", async () => {
  const handlers = new Map<string, Handler>();
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const sent: unknown[][] = [];
  const notes: string[] = [];
  const pi = {
    registerFlag: () => {},
    registerCommand: (_name: string, options: { handler: typeof command }) => (command = options.handler),
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getFlag: () => false,
    sendUserMessage: (...args: unknown[]) => sent.push(args),
  };
  remote(pi as never);
  const ctx = {
    mode: "tui",
    cwd: "C:/work/nusacode",
    model: { name: "DeepSeek V4.1 Flash" },
    isIdle: () => false,
    abort: () => {},
    sessionManager: { getEntries: () => [{ type: "message", message: { role: "user", content: "hi" } }], getSessionName: () => "demo" },
    ui: { notify: (text: string) => notes.push(text), setStatus: () => {} },
  };
  process.env.NUSACODE_REMOTE_PORT = "0";
  handlers.get("session_start")!({}, ctx);
  await command!("", ctx);
  const link = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/.exec(notes[0]);
  assert.ok(link, notes[0]);
  const headers = { Authorization: `Bearer ${link[2]}` };
  const base = `http://127.0.0.1:${link[1]}`;
  const state = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.deepEqual([state.model, state.cwd, state.sessionName, state.items[0].text], ["DeepSeek V4.1 Flash", "C:/work/nusacode", "demo", "hi"]);
  await fetch(`${base}/api/prompt`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: '{"text":"keep going"}' });
  assert.deepEqual(sent, [["keep going", { deliverAs: "followUp" }]], "queued as a follow-up while the agent is busy");
  await command!("stop", ctx);
  assert.match(notes.at(-1)!, /stopped/);
  await assert.rejects(fetch(`${base}/api/state`, { headers }));
  delete process.env.NUSACODE_REMOTE_PORT;
});

test("the page script is valid JavaScript", async () => {
  const { Script } = await import("node:vm");
  const source = /<script nonce="__NONCE__">([\s\S]*?)<\/script>/.exec(REMOTE_PAGE)?.[1];
  assert.ok(source && source.length > 500);
  assert.doesNotThrow(() => new Script(source), "the inline script should parse");
  assert.ok(source.includes('split("```")'), "code fences are split on three backticks");
});
