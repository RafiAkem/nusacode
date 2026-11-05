/**
 * /remote: watch and steer this session from a browser, for example on your phone.
 *
 *   /remote            start it, on your Tailscale address if you have one, else this computer only
 *   /remote lan        listen on your Wi-Fi address instead (plain HTTP; trusted networks only)
 *   /remote local      this computer only
 *   /remote status     show the link and how many pages are connected
 *   /remote stop       shut it down
 *   nusacode --remote  start it at launch
 *
 * Every request needs a random token. A QR code of the link is shown whenever a phone could
 * reach it. A page can send messages and stop the agent; it cannot answer questions or
 * dialogs that are open in the terminal.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { qrLines } from "../lib/qr.ts";
import { REMOTE_PAGE } from "../lib/remote-page.ts";
import { resolveHost, tailscaleIp, type Mode } from "../lib/remote-network.ts";
import { startRemoteServer, type RemoteServer } from "../lib/remote-server.ts";
import { buildState, targetOf } from "../lib/remote-state.ts";

const STATUS_KEY = "remote";
const DEFAULT_PORT = 7842;

const TIPS: Record<Mode, string> = {
  local:
    "Only this computer can open it. For your phone, install Tailscale and run /remote, or run /remote lan on a network you trust.",
  tailscale: "Reachable only from devices signed in to your Tailscale account.",
  lan: "This is plain HTTP on your local network: anyone on it who sees the link could control this session. Use it only on a network you trust. Windows may ask to allow access through the firewall.",
};

const NAMES: Record<Mode, string> = { local: "this computer only", tailscale: "over Tailscale", lan: "on your local network" };

/** The link to show: the server's own, or your own address from NUSACODE_REMOTE_URL. */
export function linkFor(server: Pick<RemoteServer, "url" | "token">, base = process.env.NUSACODE_REMOTE_URL): string {
  return base ? `${base.replace(/\/+$/, "")}/?token=${server.token}` : server.url;
}

/** The message shown after starting: the link, a QR code when a phone can use it, and what to know. */
export function describe(server: RemoteServer, mode: Mode, base = process.env.NUSACODE_REMOTE_URL): string {
  const link = linkFor(server, base);
  const n = server.clients();
  const phoneCanReach = mode !== "local" || Boolean(base);
  return [
    `Remote control is on, ${base ? "through your own address" : NAMES[mode]}. The link contains your access token, so keep it private:`,
    link,
    ...(phoneCanReach ? ["", ...qrLines(link), "", "Scan it with your phone's camera."] : []),
    `${n} page${n === 1 ? "" : "s"} connected. ${base ? "You set NUSACODE_REMOTE_URL, so the link points there; the server itself listens on this computer only." : TIPS[mode]}`,
  ].join("\n");
}

export default function remote(pi: ExtensionAPI) {
  if (process.env.NUSACODE_SUBAGENT === "1") return;

  let server: RemoteServer | null = null;
  let serverMode: Mode = "local";
  let latest: ExtensionContext | null = null;
  let live: unknown;
  let running = false;
  let busyWith: string | undefined;
  let pending: ReturnType<typeof setTimeout> | null = null;

  /** Tell connected pages to refetch; bursts of streaming events become one nudge. */
  function changed(): void {
    if (!server || pending) return;
    pending = setTimeout(() => {
      pending = null;
      server?.notify();
    }, 50);
  }

  function snapshot() {
    const ctx = latest;
    if (!ctx) return buildState({ entries: [], live: undefined, running, busyWith, model: "", cwd: "", sessionName: undefined });
    return buildState({
      entries: ctx.sessionManager.getEntries() as { type: string; message?: never }[],
      live: live as never,
      running,
      busyWith,
      model: ctx.model?.name ?? ctx.model?.id ?? "",
      cwd: ctx.cwd,
      sessionName: ctx.sessionManager.getSessionName(),
    });
  }

  async function stop(ctx: ExtensionContext): Promise<boolean> {
    if (!server) return false;
    await server.close();
    server = null;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
    return true;
  }

  /** Starts (or restarts, if the address changes) and returns the message to show. */
  async function start(ctx: ExtensionContext, requested: Mode | "auto"): Promise<string> {
    // Auto means Tailscale when it is there, because that is the safe way to reach a phone.
    const mode: Mode = requested === "auto" ? (tailscaleIp() ? "tailscale" : "local") : requested;
    if (server && serverMode !== mode) await stop(ctx);
    if (!server) {
      const where = resolveHost(mode);
      if ("error" in where) return where.error;
      server = await startRemoteServer({
        page: REMOTE_PAGE,
        host: where.host,
        preferredPort: Number(process.env.NUSACODE_REMOTE_PORT) || DEFAULT_PORT,
        handlers: {
          state: snapshot,
          prompt: (text) => {
            const idle = latest?.isIdle() ?? true;
            pi.sendUserMessage(text, idle ? undefined : { deliverAs: "followUp" });
          },
          abort: () => latest?.abort(),
        },
      });
      serverMode = mode;
      if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, `remote :${server.port}`);
    }
    return describe(server, mode);
  }

  pi.registerFlag("remote", { description: "Start remote control (a web page for this session) at launch", type: "boolean" });

  const WORDS = ["lan", "local", "status", "stop"];

  pi.registerCommand("remote", {
    description: "Control this session from a browser or phone: /remote, /remote lan, /remote status, /remote stop",
    getArgumentCompletions: (prefix) =>
      WORDS.filter((word) => word.startsWith(prefix.trim().toLowerCase())).map((word) => ({ value: word, label: word })),
    handler: async (args, ctx) => {
      latest = ctx;
      const word = args.trim().toLowerCase();
      if (word === "stop") {
        ctx.ui.notify((await stop(ctx)) ? "Remote control stopped." : "Remote control was not running.", "info");
        return;
      }
      if (word === "status") {
        ctx.ui.notify(server ? describe(server, serverMode) : "Remote control is off. Run /remote to start it.", "info");
        return;
      }
      if (word && word !== "lan" && word !== "local" && word !== "start") {
        ctx.ui.notify(`Unknown option "${word}". Use /remote, /remote lan, /remote local, /remote status or /remote stop.`, "warning");
        return;
      }
      try {
        const requested = word === "lan" || word === "local" ? word : "auto";
        ctx.ui.notify(await start(ctx, requested), "info");
      } catch (err) {
        ctx.ui.notify(`Could not start remote control: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    latest = ctx;
    live = undefined;
    changed();
    if (ctx.mode === "tui" && pi.getFlag("remote") === true && !server) {
      try {
        ctx.ui.notify(await start(ctx, "auto"), "info");
      } catch (err) {
        ctx.ui.notify(`Could not start remote control: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    latest = ctx;
    running = true;
    changed();
  });
  pi.on("agent_end", (_event, ctx) => {
    latest = ctx;
    running = false;
    busyWith = undefined;
    live = undefined;
    changed();
  });
  pi.on("message_start", (event) => {
    if ((event.message as { role?: string }).role === "assistant") live = event.message;
    changed();
  });
  pi.on("message_update", (event) => {
    live = event.message;
    changed();
  });
  pi.on("message_end", (event) => {
    if ((event.message as { role?: string }).role === "assistant") live = undefined;
    changed();
  });
  pi.on("tool_execution_start", (event) => {
    busyWith = `${event.toolName} ${targetOf(event.args)}`.trim().slice(0, 80);
    changed();
  });
  pi.on("tool_execution_end", () => {
    busyWith = undefined;
    changed();
  });
  pi.on("model_select", () => changed());
}
