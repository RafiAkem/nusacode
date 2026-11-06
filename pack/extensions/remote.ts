/**
 * /remote: watch and steer this session from a browser, for example on your phone.
 *
 *   /remote                 start it, by the best route available (see below)
 *   /remote relay [address] use the relay (and remember its address if you give one)
 *   /remote tailscale       listen on your Tailscale address
 *   /remote lan             listen on your Wi-Fi address (plain HTTP; trusted networks only)
 *   /remote local           this computer only
 *   /remote status          show the link and how many pages are connected
 *   /remote stop            shut it down
 *   nusacode --remote       start it at launch
 *
 * "Best route": the relay if one is set up, else Tailscale if it is running, else this
 * computer only. A QR code of the link is shown whenever a phone could use it. A page can send
 * messages and stop the agent; it cannot answer questions or dialogs open in the terminal.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { qrLines } from "../lib/qr.ts";
import { normalizeRelayUrl, startRelayLink, type RelayLink } from "../lib/relay-client.ts";
import { configuredRelay, saveRelay } from "../lib/relay-config.ts";
import { REMOTE_PAGE } from "../lib/remote-page.ts";
import { resolveHost, tailscaleIp, type Mode } from "../lib/remote-network.ts";
import { startRemoteServer, type RemoteServer } from "../lib/remote-server.ts";
import { buildState, LOCAL_LIMITS, RELAY_LIMITS, targetOf, type Limits } from "../lib/remote-state.ts";

const STATUS_KEY = "remote";
const DEFAULT_PORT = 7842;

type Route = Mode | "relay";

const TIPS: Record<Mode, string> = {
  local:
    "Only this computer can open it. For your phone, set up the relay (see /remote relay), use Tailscale, or run /remote lan on a network you trust.",
  tailscale: "Reachable only from devices signed in to your Tailscale account.",
  lan: "This is plain HTTP on your local network: anyone on it who sees the link could control this session. Use it only on a network you trust. Windows may ask to allow access through the firewall.",
};

const NAMES: Record<Mode, string> = { local: "this computer only", tailscale: "over Tailscale", lan: "on your local network" };

/** The link to show: the server's own, or your own address from NUSACODE_REMOTE_URL. */
export function linkFor(server: Pick<RemoteServer, "url" | "token">, base = process.env.NUSACODE_REMOTE_URL): string {
  return base ? `${base.replace(/\/+$/, "")}/?token=${server.token}` : server.url;
}

/** The message shown after starting a local server: the link, a QR code when a phone can use it, and what to know. */
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

/** The message shown after connecting to the relay. */
export function describeRelay(link: Pick<RelayLink, "link" | "viewers" | "connected">): string {
  const n = link.viewers();
  return [
    "Remote control is on, through the relay. Scan this with your phone's camera, or open the link:",
    link.link,
    "",
    ...qrLines(link.link),
    "",
    `${link.connected() ? "Connected to the relay" : "Connecting to the relay…"}, ${n} phone${n === 1 ? "" : "s"} watching.`,
    "Everything is end-to-end encrypted: the key is in the part of the link after the #, which is never sent to the relay, so it can't read or change your session.",
    "Anyone who has this link can read the session and send it messages, so don't share it. Run /remote stop when you're done.",
  ].join("\n");
}

const RELAY_HELP = [
  "No relay is set up yet. The relay is a small server you deploy once (free on Cloudflare); it lets a phone reach this session from anywhere with no other setup.",
  "Set it up with the steps at https://github.com/RafiAkem/nusacode/tree/main/relay, then run /remote relay https://your-relay.example.workers.dev",
].join("\n");

export default function remote(pi: ExtensionAPI) {
  if (process.env.NUSACODE_SUBAGENT === "1") return;

  let server: RemoteServer | null = null;
  let relay: RelayLink | null = null;
  let route: Route = "local";
  let latest: ExtensionContext | null = null;
  let live: unknown;
  let running = false;
  let busyWith: string | undefined;
  let pending: ReturnType<typeof setTimeout> | null = null;

  /** Tell connected pages to refetch; bursts of streaming events become one nudge. */
  function changed(): void {
    if (!(server || relay) || pending) return;
    pending = setTimeout(() => {
      pending = null;
      server?.notify();
      relay?.notify();
    }, 50);
  }

  function snapshot(limits: Limits = LOCAL_LIMITS) {
    const ctx = latest;
    if (!ctx) return buildState({ entries: [], live: undefined, running, busyWith, model: "", cwd: "", sessionName: undefined }, limits);
    return buildState(
      {
        entries: ctx.sessionManager.getEntries() as { type: string; message?: never }[],
        live: live as never,
        running,
        busyWith,
        model: ctx.model?.name ?? ctx.model?.id ?? "",
        cwd: ctx.cwd,
        sessionName: ctx.sessionManager.getSessionName(),
      },
      limits,
    );
  }

  const handlePrompt = (text: string) => {
    const idle = latest?.isIdle() ?? true;
    pi.sendUserMessage(text, idle ? undefined : { deliverAs: "followUp" });
  };
  const handleAbort = () => latest?.abort();

  async function stop(ctx: ExtensionContext): Promise<boolean> {
    if (!server && !relay) return false;
    await server?.close();
    relay?.close();
    server = null;
    relay = null;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
    return true;
  }

  function showStatus(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    if (relay) ctx.ui.setStatus(STATUS_KEY, `remote ${relay.connected() ? `${relay.viewers()} watching` : "connecting"}`);
    else if (server) ctx.ui.setStatus(STATUS_KEY, `remote :${server.port}`);
  }

  /** Picks the route when none is asked for: relay, then Tailscale, then this computer. */
  function chooseRoute(): Route {
    if (configuredRelay()) return "relay";
    return tailscaleIp() ? "tailscale" : "local";
  }

  /** Starts (or restarts, if the route changes) and returns the message to show. */
  async function start(ctx: ExtensionContext, requested: Route | "auto", relayAddress?: string): Promise<string> {
    if (relayAddress) {
      if (!saveRelay(relayAddress)) return `"${relayAddress}" is not a usable relay address. It should start with https://`;
    }
    const wanted: Route = requested === "auto" ? chooseRoute() : requested;
    if ((server || relay) && route !== wanted) await stop(ctx);

    if (wanted === "relay") {
      const address = configuredRelay();
      if (!address) return RELAY_HELP;
      if (!relay) {
        relay = await startRelayLink({
          relayUrl: address,
          handlers: { state: () => snapshot(RELAY_LIMITS), prompt: handlePrompt, abort: handleAbort },
          onChange: () => showStatus(ctx),
        });
        route = "relay";
        showStatus(ctx);
      }
      return describeRelay(relay);
    }

    if (!server) {
      const where = resolveHost(wanted);
      if ("error" in where) return where.error;
      server = await startRemoteServer({
        page: REMOTE_PAGE,
        host: where.host,
        preferredPort: Number(process.env.NUSACODE_REMOTE_PORT) || DEFAULT_PORT,
        handlers: { state: () => snapshot(), prompt: handlePrompt, abort: handleAbort },
      });
      route = wanted;
      showStatus(ctx);
    }
    return describe(server, wanted);
  }

  pi.registerFlag("remote", { description: "Start remote control (a web page for this session) at launch", type: "boolean" });

  const WORDS = ["relay", "tailscale", "lan", "local", "status", "stop"];

  pi.registerCommand("remote", {
    description: "Control this session from a browser or phone: /remote, /remote relay, /remote status, /remote stop",
    getArgumentCompletions: (prefix) =>
      WORDS.filter((word) => word.startsWith(prefix.trim().toLowerCase())).map((word) => ({ value: word, label: word })),
    handler: async (args, ctx) => {
      latest = ctx;
      const [first = "", second] = args.trim().split(/\s+/);
      const word = first.toLowerCase();
      if (word === "stop") {
        ctx.ui.notify((await stop(ctx)) ? "Remote control stopped." : "Remote control was not running.", "info");
        return;
      }
      if (word === "status") {
        ctx.ui.notify(
          relay ? describeRelay(relay) : server ? describe(server, route as Mode) : "Remote control is off. Run /remote to start it.",
          "info",
        );
        return;
      }
      if (word && !WORDS.includes(word) && word !== "start") {
        ctx.ui.notify(`Unknown option "${word}". Use /remote, /remote relay, /remote tailscale, /remote lan, /remote local, /remote status or /remote stop.`, "warning");
        return;
      }
      if (second && word !== "relay") {
        ctx.ui.notify(`/remote ${word} takes no address.`, "warning");
        return;
      }
      if (second && !normalizeRelayUrl(second)) {
        ctx.ui.notify(`"${second}" is not a usable relay address. It should start with https://`, "warning");
        return;
      }
      try {
        const requested: Route | "auto" = word === "relay" || word === "tailscale" || word === "lan" || word === "local" ? word : "auto";
        ctx.ui.notify(await start(ctx, requested, second), "info");
      } catch (err) {
        ctx.ui.notify(`Could not start remote control: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    latest = ctx;
    live = undefined;
    changed();
    if (ctx.mode === "tui" && pi.getFlag("remote") === true && !server && !relay) {
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
