/**
 * The remote page: one self-contained HTML document, no external requests, in two flavours.
 *
 *   REMOTE_PAGE  talks to the local server over HTTP (see remote-server.ts)
 *   RELAY_PAGE   talks to the relay over an encrypted WebSocket (see relay/ and relay-client.ts)
 *
 * They share all the drawing code and differ only in how state arrives and prompts leave.
 * Text from the session is only ever set with textContent, never as HTML.
 * __NONCE__ is replaced per response so the Content-Security-Policy can allow just this script.
 *
 * The script is written with String.raw so its backslashes mean what they say, and it never
 * contains a backtick or a dollar-brace, so no escaping is needed.
 */

/**
 * The phone's half of relay-crypto.ts. A test runs it against the Node version.
 * `key` is the base64url key from the link; direction 1 is agent to phone, 2 is phone to agent.
 */
export const PAGE_CRYPTO = String.raw`
function b64decode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function importKey(key) {
  return crypto.subtle.importKey("raw", b64decode(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(key, direction, message) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(message));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new Uint8Array([direction]) }, await importKey(key), plain));
  const frame = new Uint8Array(12 + body.length);
  frame.set(iv, 0);
  frame.set(body, 12);
  return frame;
}
async function open(key, direction, buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 28) return undefined;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new Uint8Array([direction]) }, await importKey(key), bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (error) {
    return undefined;
  }
}
`;

const STYLE = String.raw`
  :root { --bg:#0b0b0b; --panel:#102b22; --line:#284b3c; --text:#e6f2ec; --muted:#a2bcb0; --dim:#7c9a8d; --accent:#4ed899; --red:#f87171; --user:#0f3a2a; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; }
  body { display: flex; flex-direction: column; }
  header { padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  header b { color: var(--accent); }
  header .meta { color: var(--dim); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); flex: none; }
  .dot.live { background: var(--accent); animation: pulse 1s infinite; }
  .dot.off { background: var(--red); }
  @keyframes pulse { 50% { opacity: .3; } }
  main { flex: 1; overflow-y: auto; padding: 12px 14px 20px; }
  .msg { margin: 10px 0; white-space: pre-wrap; word-break: break-word; }
  .user { background: var(--user); padding: 8px 12px; border-radius: 6px; }
  .tool { border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; margin: 8px 0; color: var(--muted); }
  .tool summary { cursor: pointer; list-style: none; }
  .tool summary::-webkit-details-marker { display: none; }
  .tool .ok { color: var(--accent); } .tool .bad { color: var(--red); } .tool .run { color: var(--accent); }
  .tool .name { color: var(--text); font-weight: 700; }
  .tool pre { margin: 8px 0 0; padding: 8px; background: #000; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; color: var(--muted); font-size: 13px; }
  pre.code { background: #000; padding: 8px 10px; border-radius: 4px; overflow-x: auto; white-space: pre; margin: 8px 0; }
  .empty { color: var(--dim); text-align: center; margin-top: 30vh; }
  form { display: flex; gap: 8px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); }
  textarea { flex: 1; resize: none; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font: inherit; max-height: 30vh; }
  textarea:focus { outline: 1px solid var(--accent); }
  button { background: var(--accent); color: #04140d; border: 0; border-radius: 6px; padding: 0 16px; font: inherit; font-weight: 700; cursor: pointer; }
  button.stop { background: transparent; color: var(--red); border: 1px solid var(--red); }
  button:disabled { opacity: .4; cursor: default; }
`;

/** Drawing, the composer, and the `ui` object the transports use. */
const COMMON = String.raw`
const log = document.getElementById("log"), meta = document.getElementById("meta"), dot = document.getElementById("dot");
const box = document.getElementById("box"), send = document.getElementById("send"), stop = document.getElementById("stop");
const FENCE = String.fromCharCode(96).repeat(3);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function richText(text) {
  const wrap = el("div", "msg");
  text.split(FENCE).forEach((part, i) => {
    if (i % 2 === 1) wrap.appendChild(el("pre", "code", part.replace(/^[^\n]*\n/, "").replace(/\n$/, "")));
    else if (part.trim()) wrap.appendChild(document.createTextNode(part.replace(/^\n+|\n+$/g, "")));
  });
  return wrap;
}

function toolCard(item, result, live) {
  const card = el("details", "tool");
  const head = el("summary");
  const state = result ? (result.isError ? "bad" : "ok") : "run";
  head.appendChild(el("span", state, result ? (result.isError ? "✗ " : "✓ ") : (live ? "⠇ " : "· ")));
  head.appendChild(el("span", "name", item.name));
  if (item.target) head.appendChild(document.createTextNode(" " + item.target));
  card.appendChild(head);
  if (result && result.text) card.appendChild(el("pre", null, result.text));
  return card;
}

let handlers = { prompt: () => {}, stop: () => {} };
const ui = {
  onPrompt(fn) { handlers.prompt = fn; },
  onStop(fn) { handlers.stop = fn; },
  status(text, mode) { meta.textContent = text; dot.className = "dot" + (mode ? " " + mode : ""); },
  draw(state) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const results = new Map();
    [...state.items, ...state.live].forEach((it) => { if (it.kind === "result") results.set(it.id, it); });
    const frag = document.createDocumentFragment();
    const all = [...state.items.map((i) => [i, false]), ...state.live.map((i) => [i, true])];
    all.forEach(([it, live]) => {
      if (it.kind === "user") frag.appendChild(el("div", "msg user", it.text));
      else if (it.kind === "assistant") frag.appendChild(richText(it.text));
      else if (it.kind === "tool") frag.appendChild(toolCard(it, results.get(it.id), live || state.running));
    });
    if (!all.length) frag.appendChild(el("div", "empty", "No messages yet. Say something below."));
    log.replaceChildren(frag);
    meta.textContent = [state.model, state.cwd, state.sessionName].filter(Boolean).join(" · ") + (state.busyWith ? " · " + state.busyWith : "");
    dot.className = "dot" + (state.running ? " live" : "");
    stop.hidden = !state.running;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  },
};

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = box.value.trim();
  if (!text) return;
  send.disabled = true;
  await handlers.prompt(text);
  box.value = "";
  send.disabled = false;
  box.focus();
});
box.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); document.getElementById("form").requestSubmit(); }
});
stop.addEventListener("click", () => handlers.stop());
`;

/** State from the local server over HTTP, refetched whenever it says something changed. */
const LOCAL_TRANSPORT = String.raw`
let loading = false, again = false;

async function load() {
  if (loading) { again = true; return; }
  loading = true;
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (res.status === 401) { ui.status("Not authorized. Reopen the link from /remote.", "off"); return; }
    ui.draw(await res.json());
  } catch (error) { ui.status("Can't reach NusaCode.", "off"); }
  finally { loading = false; if (again) { again = false; load(); } }
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!res.ok) ui.status("Request failed (" + res.status + ")", "off");
}

ui.onPrompt((text) => post("/api/prompt", { text }));
ui.onStop(() => post("/api/abort"));

const source = new EventSource("/api/events");
let timer = 0;
source.onmessage = () => { clearTimeout(timer); timer = setTimeout(load, 60); };
source.onopen = load;
source.onerror = () => ui.status("Reconnecting…", "off");
load();
`;

/** State from the relay: encrypted frames, rebuilt from small updates. */
const RELAY_TRANSPORT = String.raw`
${PAGE_CRYPTO}
const sid = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
const key = location.hash.slice(1);
const vid = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");
let seq = 0, items = [], socket = null, retry = 0, ended = false;

function applyUpdate(update) {
  items = items.slice(0, update.from).concat(update.items);
  ui.draw({ items, live: update.live, running: update.running, busyWith: update.busyWith, model: update.model, cwd: update.cwd, sessionName: update.sessionName });
}

async function sendMessage(message) {
  if (!socket || socket.readyState !== 1) { ui.status("Not connected. Reconnecting…", "off"); return; }
  seq += 1;
  socket.send(await seal(key, 2, Object.assign({ vid, seq }, message)));
}

function connect() {
  if (!key) { ui.status("This link is missing its key. Scan the QR code again.", "off"); return; }
  ui.status("Connecting…");
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/" + encodeURIComponent(sid) + "?role=viewer";
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => { retry = 0; sendMessage({ t: "sync" }); };
  socket.onmessage = async (event) => {
    if (typeof event.data === "string") {
      try {
        const info = JSON.parse(event.data);
        if (info.r === "agent" && !info.up) ui.status("Waiting for NusaCode to reconnect…", "off");
        if (info.r === "agent" && info.up) sendMessage({ t: "sync" });
      } catch (error) { /* not ours */ }
      return;
    }
    const message = await open(key, 1, event.data);
    if (message && message.t === "state") applyUpdate(message);
  };
  socket.onclose = (event) => {
    if (event.reason === "session ended") { ended = true; ui.status("This session has ended.", "off"); return; }
    ui.status("Disconnected. Reconnecting…", "off");
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * retry * retry);
  };
}

ui.onPrompt((text) => sendMessage({ t: "prompt", text }));
ui.onStop(() => sendMessage({ t: "abort" }));
setInterval(() => { if (!ended && socket && socket.readyState === 1) socket.send("ping"); }, 25000);
connect();
`;

function shell(script: string): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="referrer" content="no-referrer">
<title>NusaCode remote</title>
<style nonce="__NONCE__">${STYLE}</style>
</head>
<body>
<header><span class="dot" id="dot"></span><b>NusaCode</b><span class="meta" id="meta">connecting…</span></header>
<main id="log"><div class="empty">Loading the session…</div></main>
<form id="form">
  <textarea id="box" rows="2" placeholder="Message NusaCode. Enter sends, Shift+Enter adds a line." autocomplete="off"></textarea>
  <button id="send" type="submit">Send</button>
  <button id="stop" class="stop" type="button" hidden>Stop</button>
</form>
<script nonce="__NONCE__">
(() => {
${COMMON}
${script}
})();
</script>
</body>
</html>
`;
}

export const REMOTE_PAGE = shell(LOCAL_TRANSPORT);
export const RELAY_PAGE = shell(RELAY_TRANSPORT);
