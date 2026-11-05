/**
 * /remote: watch and steer this session from a browser, for example on your phone.
 *
 *   /remote           start the server and print the link
 *   /remote status    show the link and how many pages are connected
 *   /remote stop      shut it down
 *   nusacode --remote start it at launch
 *
 * The server listens on 127.0.0.1 only and needs a random token. To reach it from another
 * device, tunnel to the port with Tailscale or SSH. A page can send messages and stop the
 * agent; it cannot answer questions or dialogs that are open in the terminal.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REMOTE_PAGE } from "../lib/remote-page.ts";
import { startRemoteServer, type RemoteServer } from "../lib/remote-server.ts";
import { buildState, targetOf } from "../lib/remote-state.ts";

const STATUS_KEY = "remote";
const DEFAULT_PORT = 7842;

export default function remote(pi: ExtensionAPI) {
  if (process.env.NUSACODE_SUBAGENT === "1") return;

  let server: RemoteServer | null = null;
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

  async function start(ctx: ExtensionContext): Promise<RemoteServer> {
    if (server) return server;
    server = await startRemoteServer({
      page: REMOTE_PAGE,
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
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, `remote :${server.port}`);
    return server;
  }

  async function stop(ctx: ExtensionContext): Promise<boolean> {
    if (!server) return false;
    await server.close();
    server = null;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
    return true;
  }

  function describe(current: RemoteServer): string {
    const n = current.clients();
    return [
      `Remote control is on. Open this link (it contains your access token, so keep it private):`,
      current.url,
      `${n} page${n === 1 ? "" : "s"} connected. It only listens on this computer: to use it from a phone, tunnel to port ${current.port} with Tailscale or \`ssh -L ${current.port}:127.0.0.1:${current.port} <this-computer>\`.`,
    ].join("\n");
  }

  pi.registerFlag("remote", { description: "Start remote control (a local web page for this session) at launch", type: "boolean" });

  pi.registerCommand("remote", {
    description: "Control this session from a browser: /remote, /remote status or /remote stop",
    getArgumentCompletions: (prefix) =>
      ["status", "stop"].filter((word) => word.startsWith(prefix.trim().toLowerCase())).map((word) => ({ value: word, label: word })),
    handler: async (args, ctx) => {
      latest = ctx;
      const word = args.trim().toLowerCase();
      if (word === "stop") {
        ctx.ui.notify((await stop(ctx)) ? "Remote control stopped." : "Remote control was not running.", "info");
        return;
      }
      if (word === "status" && !server) {
        ctx.ui.notify("Remote control is off. Run /remote to start it.", "info");
        return;
      }
      if (word && word !== "status" && word !== "start") {
        ctx.ui.notify(`Unknown option "${word}". Use /remote, /remote status or /remote stop.`, "warning");
        return;
      }
      try {
        ctx.ui.notify(describe(await start(ctx)), "info");
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
        ctx.ui.notify(describe(await start(ctx)), "info");
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
