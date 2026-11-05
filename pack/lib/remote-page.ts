/**
 * The remote page: one self-contained HTML document, no external requests.
 * Text from the session is only ever set with textContent, never as HTML.
 * __NONCE__ is replaced per response so the Content-Security-Policy can allow just this script.
 */
export const REMOTE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>NusaCode remote</title>
<style nonce="__NONCE__">
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
</style>
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
  const log = document.getElementById("log"), meta = document.getElementById("meta"), dot = document.getElementById("dot");
  const box = document.getElementById("box"), send = document.getElementById("send"), stop = document.getElementById("stop");
  let loading = false, again = false;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  // Text with \`\`\` fences becomes paragraphs and code blocks; nothing is parsed as HTML.
  function richText(text) {
    const wrap = el("div", "msg");
    text.split("\`\`\`").forEach((part, i) => {
      if (i % 2 === 1) wrap.appendChild(el("pre", "code", part.replace(/^[^\\n]*\\n/, "").replace(/\\n$/, "")));
      else if (part.trim()) wrap.appendChild(document.createTextNode(part.replace(/^\\n+|\\n+$/g, "")));
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

  function draw(state) {
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
  }

  async function load() {
    if (loading) { again = true; return; }
    loading = true;
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.status === 401) { meta.textContent = "Not authorized. Reopen the link from /remote."; dot.className = "dot off"; return; }
      draw(await res.json());
    } catch { dot.className = "dot off"; }
    finally { loading = false; if (again) { again = false; load(); } }
  }

  function listen() {
    const source = new EventSource("/api/events");
    let timer = 0;
    source.onmessage = () => { clearTimeout(timer); timer = setTimeout(load, 60); };
    source.onopen = load;
    source.onerror = () => { dot.className = "dot off"; };
  }

  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    if (!res.ok) meta.textContent = "Request failed (" + res.status + ")";
  }

  document.getElementById("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    send.disabled = true;
    await post("/api/prompt", { text });
    box.value = "";
    send.disabled = false;
    box.focus();
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); document.getElementById("form").requestSubmit(); }
  });
  stop.addEventListener("click", () => post("/api/abort"));

  load();
  listen();
})();
</script>
</body>
</html>
`;
