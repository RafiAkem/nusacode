/**
 * The NusaCode relay, as a Cloudflare Worker.
 *
 *   GET /s/<session>        the phone page; the key is in the # part, which never reaches here
 *   GET /ws/<session>       the WebSocket for either side (?role=agent&proof=... or ?role=viewer)
 *   GET /                   a short explanation
 *
 * Each session is one Durable Object (see room.ts). Everything between agent and phone is
 * end-to-end encrypted, so this Worker never holds anything it could read.
 */
import { RELAY_PAGE } from "../../pack/lib/remote-page.ts";
import type { Env } from "./types.d.ts";

export { RelayRoom } from "./room.ts";

const SESSION = /^[A-Za-z0-9_-]{16,64}$/;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function nonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

const LANDING = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NusaCode relay</title>
<body style="font:16px/1.5 system-ui;background:#0b0b0b;color:#e6f2ec;max-width:34rem;margin:15vh auto;padding:0 1rem">
<h1 style="color:#4ed899">NusaCode relay</h1>
<p>This server connects NusaCode on a computer to a browser on a phone. Everything between them is end-to-end encrypted with a key that only the two of them hold, so this server cannot read or change a session.</p>
<p>To use it, run <code>/remote</code> in NusaCode and scan the QR code.</p>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && parts.length === 0) {
      return new Response(LANDING, { headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } });
    }

    if (request.method === "GET" && parts[0] === "healthz") return new Response("ok\n", { headers: HEADERS });

    if (request.method === "GET" && parts[0] === "s" && parts.length === 2 && SESSION.test(parts[1])) {
      const n = nonce();
      return new Response(RELAY_PAGE.replaceAll("__NONCE__", n), {
        headers: {
          ...HEADERS,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; connect-src 'self' wss://${url.host}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        },
      });
    }

    if (parts[0] === "ws" && parts.length === 2 && SESSION.test(parts[1])) {
      // A phone's page must come from this same site; the agent (not a browser) sends no Origin.
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return new Response("Wrong origin.\n", { status: 403 });
      const room = env.ROOMS.get(env.ROOMS.idFromName(parts[1]));
      return room.fetch(request);
    }

    return new Response("Not found.\n", { status: 404, headers: HEADERS });
  },
};
