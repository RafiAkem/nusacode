/**
 * Keeping the phone's copy of the session up to date without resending all of it.
 *
 * The agent remembers what it last sent. Each update carries only the items from the first
 * one that changed, plus the small facts around them. The phone replaces its items from that
 * point on. Asking the agent to `sync` resets what it remembers, so the next update is whole.
 */
import type { Item, RemoteState } from "./remote-state.ts";

export type Update = {
  t: "state";
  /** Items before this index are unchanged on the phone. */
  from: number;
  items: Item[];
  live: Item[];
  running: boolean;
  busyWith: string | undefined;
  model: string;
  cwd: string;
  sessionName: string | undefined;
};

const same = (a: Item | undefined, b: Item | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** The update that takes a phone holding `previous` to `next`; `previous` undefined means send everything. */
export function makeUpdate(previous: Item[] | undefined, next: RemoteState): Update {
  let from = 0;
  if (previous) {
    const limit = Math.min(previous.length, next.items.length);
    while (from < limit && same(previous[from], next.items[from])) from++;
  }
  return {
    t: "state",
    from,
    items: next.items.slice(from),
    live: next.live,
    running: next.running,
    busyWith: next.busyWith,
    model: next.model,
    cwd: next.cwd,
    sessionName: next.sessionName,
  };
}

/** What the phone does with an update: the new full state. */
export function applyUpdate(items: Item[], update: Update): RemoteState {
  return {
    items: items.slice(0, update.from).concat(update.items),
    live: update.live,
    running: update.running,
    busyWith: update.busyWith,
    model: update.model,
    cwd: update.cwd,
    sessionName: update.sessionName,
  };
}

/** Remembers what was sent, so each call returns only what is new. */
export class UpdateStream {
  private sent: Item[] | undefined;

  next(state: RemoteState): Update {
    const update = makeUpdate(this.sent, state);
    this.sent = state.items;
    return update;
  }

  /** The next update will carry everything, for a phone that just connected. */
  reset(): void {
    this.sent = undefined;
  }
}
