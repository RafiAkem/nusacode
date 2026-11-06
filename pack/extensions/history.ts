/**
 * Spending history: saves every priced response to usage.jsonl in the NusaCode home, so
 * `/usage` can show today's and this month's totals and `/usage history` can compare
 * models. The meter publishes each response on COST_CHANNEL; this file only records it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/home.ts";
import { appendRecord, pruneLog } from "../lib/usage-log.ts";
import { COST_CHANNEL, type CostEvent } from "./meter.ts";

export default function history(pi: ExtensionAPI) {
  let lastCtx: ExtensionContext | null = null;

  function sessionId(): string | undefined {
    try {
      return lastCtx?.sessionManager.getSessionId();
    } catch {
      return undefined; // The context went stale while a session was being replaced.
    }
  }

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    try {
      pruneLog(agentDir(), new Date());
    } catch {
      // An unreadable log is left alone; recording still works.
    }
  });

  pi.on("message_end", (_event, ctx) => {
    lastCtx = ctx;
  });

  pi.events.on(COST_CHANNEL, (data) => {
    const event = data as CostEvent;
    try {
      appendRecord(agentDir(), {
        t: new Date().toISOString(),
        session: sessionId(),
        model: `${event.provider}/${event.model}`,
        cost: event.costIdr,
        fresh: event.freshInput,
        cached: event.cacheRead,
        output: event.output,
        ...(event.source === "subagent" ? { sub: true as const } : {}),
        ...(event.unpriced ? { unpriced: true as const } : {}),
      });
    } catch {
      // History is a convenience: a full disk must not interrupt the session.
    }
  });
}
