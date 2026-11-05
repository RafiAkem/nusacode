/**
 * The web server behind /remote.
 *
 * It listens on 127.0.0.1 only. Every request must carry the session's random token, as a
 * cookie, a bearer header, or (once, on the landing page) a ?token= query that is turned
 * into a cookie. To reach it from a phone, tunnel to it with Tailscale or SSH; nothing here
 * is exposed to the network by itself.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export type RemoteHandlers = {
  /** A JSON snapshot of the session, for the page to draw. */
  state(): unknown;
  prompt(text: string): void;
  abort(): void;
};

export type RemoteServer = {
  url: string;
  port: number;
  token: string;
  /** Tell connected pages the session changed so they refetch. */
  notify(): void;
  clients(): number;
  close(): Promise<void>;
};

const COOKIE = "nsc_remote";
const MAX_BODY = 64 * 1024;
const HEARTBEAT_MS = 20_000;

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

/** A POST must come from this same server's page, never from another website. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl and scripts send none; they still need the token
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8", headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

export function startRemoteServer(options: {
  handlers: RemoteHandlers;
  page: string;
  token?: string;
  /** Tried first; if it is taken, any free port is used. */
  preferredPort?: number;
}): Promise<RemoteServer> {
  const token = options.token ?? newToken();
  const sse = new Set<ServerResponse>();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    // The landing link carries the token once; swap it for a cookie and drop it from the URL.
    if (method === "GET" && url.pathname === "/" && sameToken(url.searchParams.get("token") ?? undefined, token)) {
      return send(res, 302, "", "text/plain", {
        Location: "/",
        "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }

    if (!sameToken(cookieToken(req) ?? bearerToken(req), token)) {
      return send(res, 401, "Unauthorized. Open the link that /remote printed in NusaCode.\n");
    }

    if (method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      return send(res, 200, options.page.replaceAll("__NONCE__", nonce), "text/html; charset=utf-8", {
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }

    if (method === "GET" && url.pathname === "/api/state") {
      return send(res, 200, JSON.stringify(options.handlers.state()), "application/json");
    }

    if (method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
      res.write("retry: 2000\n\n");
      sse.add(res);
      req.on("close", () => sse.delete(res));
      return;
    }

    if (method === "POST" && (url.pathname === "/api/prompt" || url.pathname === "/api/abort")) {
      if (!sameOrigin(req)) return send(res, 403, "Cross-origin request refused.\n");
      if (url.pathname === "/api/abort") {
        options.handlers.abort();
        return send(res, 200, "{}", "application/json");
      }
      const raw = await readBody(req);
      let text = "";
      try {
        text = typeof JSON.parse(raw ?? "").text === "string" ? JSON.parse(raw ?? "").text.trim() : "";
      } catch {
        // falls through to the empty check
      }
      if (!text) return send(res, 400, "Send JSON like {\"text\": \"...\"}.\n");
      options.handlers.prompt(text);
      return send(res, 200, "{}", "application/json");
    }

    return send(res, 404, "Not found.\n");
  });

  const heartbeat = setInterval(() => {
    for (const client of sse) client.write(": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

  return (async () => {
    try {
      await listen(options.preferredPort ?? 0);
    } catch {
      await listen(0);
    }
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      url: `http://127.0.0.1:${port}/?token=${token}`,
      port,
      token,
      notify: () => {
        for (const client of sse) client.write('data: {"type":"changed"}\n\n');
      },
      clients: () => sse.size,
      close: () =>
        new Promise<void>((resolve) => {
          clearInterval(heartbeat);
          for (const client of sse) client.end();
          sse.clear();
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
  })();
}
