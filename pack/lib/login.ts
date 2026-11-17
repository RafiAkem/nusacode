/**
 * "Sign in with NusaGate" for `/login` and `/setup`: PKCE against nusagate.com/dashboard/connect, the
 * code comes back to a one-shot listener on 127.0.0.1, and is swapped for an ordinary
 * API key at /api/auth/keys. The key is stored as the OAuth "access" token; it never
 * expires and is revoked from the NusaGate dashboard, so refresh hands it back unchanged.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const APP_NAME = "NusaCode";
/** Overridable for testing against a local gateway. */
export const SITE_URL = (process.env.NUSACODE_SITE_URL ?? "https://nusagate.com").replace(/\/+$/, "");
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export type Pkce = { verifier: string; challenge: string; state: string };

export function makePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(16).toString("base64url"),
  };
}

export function connectUrl(site: string, callback: string, pkce: Pkce): string {
  const url = new URL("/dashboard/connect", site);
  url.search = new URLSearchParams({
    callback_url: callback,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    app: APP_NAME,
    state: pkce.state,
  }).toString();
  return url.toString();
}

/**
 * The code from a redirect URL the browser landed on, checked against our state.
 * Also accepts a bare code, for someone pasting just that.
 */
export function codeFrom(input: string, state: string): string {
  const text = input.trim();
  if (!/^https?:\/\//i.test(text)) {
    if (!text) throw new Error("No code given");
    return text;
  }
  const params = new URL(text).searchParams;
  if (params.get("error")) throw new Error(params.get("error") === "access_denied" ? "Sign-in was cancelled" : `Sign-in failed: ${params.get("error")}`);
  if (params.get("state") !== state) throw new Error("Sign-in answer did not match this request; try /login again");
  const code = params.get("code");
  if (!code) throw new Error("The redirect had no code");
  return code;
}

const PAGE = (title: string) =>
  `<!doctype html><meta charset="utf-8"><title>NusaCode</title><body style="font:16px system-ui;padding:48px">` +
  `<h1 style="font-size:22px">${title}</h1><p>You can close this tab and go back to NusaCode.</p>`;

/**
 * A listener on a random loopback port that resolves with the first /callback redirect URL.
 * Listens on [::1] too, on the same port: Next.js rewrites the first "127.0.0.1" in a URL to
 * "localhost", so after a login redirect the browser may come back to localhost, which can
 * resolve to ::1.
 */
export async function listenForRedirect(signal?: AbortSignal): Promise<{ callback: string; redirect: Promise<string>; close: () => void }> {
  let server!: Server;
  let server6: Server | undefined;
  const redirect = new Promise<string>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.has("code");
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE(ok ? "Signed in to NusaGate" : "Sign-in did not finish"));
      resolve(`http://127.0.0.1${req.url}`);
    });
    // An already-aborted signal never fires "abort", so check it too, or this would wait forever.
    if (signal?.aborted) reject(new Error("Sign-in cancelled"));
    else signal?.addEventListener("abort", () => reject(new Error("Sign-in cancelled")), { once: true });
  });
  // A cancel can land when nobody awaits this yet; that must not be an unhandled rejection.
  redirect.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const handler = server.listeners("request")[0] as Parameters<typeof createServer>[0];
  await new Promise<void>((resolve) => {
    const s = createServer(handler);
    s.once("error", () => resolve()); // no IPv6, or the port is taken there: 127.0.0.1 still works
    s.listen(port, "::1", () => {
      server6 = s;
      resolve();
    });
  });
  return {
    callback: `http://127.0.0.1:${port}/callback`,
    redirect,
    close: () => {
      server.close();
      server6?.close();
    },
  };
}

export async function exchangeCode(site: string, code: string, verifier: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${site}/api/auth/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, app: APP_NAME }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { apiKey?: unknown; message?: unknown };
  if (!res.ok || typeof body.apiKey !== "string") {
    throw new Error(typeof body.message === "string" ? body.message : `NusaGate refused the sign-in (${res.status})`);
  }
  return body.apiKey;
}

type Callbacks = {
  onAuth(info: { url: string; instructions?: string }): void;
  onProgress?(message: string): void;
  onManualCodeInput?(): Promise<string>;
  signal?: AbortSignal;
};

/**
 * The whole browser sign-in, resolving with the API key. `show` gets the consent URL
 * (open it, print it); `manual` optionally races a pasted redirect URL against the listener.
 */
export async function signInWithBrowser(
  show: (url: string) => void,
  opts: { manual?: () => Promise<string>; progress?: (message: string) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const pkce = makePkce();
  const listener = await listenForRedirect(opts.signal);
  try {
    // Esc while the listener was starting: stay quiet, don't open a browser.
    if (opts.signal?.aborted) throw new Error("Sign-in cancelled");
    show(connectUrl(SITE_URL, listener.callback, pkce));
    // Whichever comes first: the browser hitting our listener, or a pasted redirect URL.
    const manual = opts.manual?.();
    const landed = await (manual ? Promise.race([listener.redirect, manual]) : listener.redirect);
    opts.progress?.("Getting your API key…");
    return await exchangeCode(SITE_URL, codeFrom(landed, pkce.state), pkce.verifier, opts.signal);
  } finally {
    listener.close();
  }
}

/** Opens a URL in the default browser; the URL is an argument, never parsed by a shell. */
export function openUrl(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {}); // no browser: the URL is on screen to copy
  child.unref();
}

/** pi's `oauth` block for the nusagate provider. */
export const nusagateOAuth = {
  name: "NusaGate",
  async login(cb: Callbacks) {
    const key = await signInWithBrowser(
      (url) => cb.onAuth({ url, instructions: "Approve NusaCode in the browser. On another machine, paste the URL the browser ends up on." }),
      { manual: cb.onManualCodeInput, progress: cb.onProgress, signal: cb.signal },
    );
    return { access: key, refresh: key, expires: Date.now() + TEN_YEARS_MS };
  },
  async refreshToken<T>(credentials: T): Promise<T> {
    return credentials;
  },
  getApiKey(credentials: { access: string }): string {
    return credentials.access;
  },
};
