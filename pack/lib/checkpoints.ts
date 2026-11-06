import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Remembers what each prompt changed, so `/undo` can put it back.
 *
 * Before the agent's own `write` or `edit` touches a file, the file's contents are kept (or the
 * fact that it didn't exist). After the call, a fingerprint of the result is kept too. Undoing a
 * prompt restores the files whose contents actually changed during it, and warns about any file
 * that has been changed again since, by you or by a command.
 *
 * This only knows about the agent's own file tools. A change made by a shell command or by a
 * subagent runs outside it, and is not undone.
 */

/** A file bigger than this is not kept, so undoing it is not possible and the report says so. */
export const MAX_FILE_BYTES = 5_000_000;
/** Across all remembered prompts, the oldest are forgotten past this. */
export const MAX_TOTAL_BYTES = 100_000_000;
export const MAX_TURNS = 20;

type Tracked = {
  /** Contents before the prompt first touched the file; null when it didn't exist. */
  before: Buffer | null;
  /** True when the file was too big to keep. */
  tooBig: boolean;
  /** Fingerprint after the latest change: "missing" when the file is gone, undefined until a call finished. */
  after?: string;
};

type Turn = { label: string; at: Date; files: Map<string, Tracked> };

export type Change = {
  path: string;
  kind: "created" | "modified";
  /** The file is not what the agent left behind, so undoing overwrites something newer. */
  conflict: boolean;
  /** Too big to restore. */
  unrestorable: boolean;
};

export type UndoResult = { restored: string[]; deleted: string[]; failed: { path: string; error: string }[]; skipped: string[] };

const fingerprint = (content: Buffer | null): string =>
  content === null ? "missing" : createHash("sha1").update(content).digest("hex");

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** A tool's path the way pi reads it: a leading `@` is dropped, `~` is the home folder, and it is relative to the working folder. */
export function resolveToolPath(path: string, cwd: string): string {
  const plain = path.startsWith("@") ? path.slice(1) : path;
  if (plain === "~") return homedir();
  if (plain.startsWith("~/") || plain.startsWith("~\\")) return resolve(homedir(), plain.slice(2));
  return resolve(cwd, plain);
}

export class Checkpoints {
  private turns: Turn[] = [];
  private current: Turn | null = null;

  /** A new prompt starts: what follows belongs to it. */
  startTurn(label: string, now = new Date()): void {
    this.current = { label, at: now, files: new Map() };
    this.turns.push(this.current);
    this.forget();
  }

  /** Call before a file tool runs. Only the first call for a file in a prompt keeps anything. */
  before(path: string): void {
    const turn = this.current;
    if (!turn || turn.files.has(path)) return;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // Doesn't exist yet, or can't be read: treated as a new file below.
    }
    if (size > MAX_FILE_BYTES) {
      turn.files.set(path, { before: null, tooBig: true });
      return;
    }
    turn.files.set(path, { before: readOrNull(path), tooBig: false });
  }

  /** Call after a file tool has finished, whether or not it succeeded. */
  after(path: string): void {
    const tracked = this.current?.files.get(path);
    if (tracked) tracked.after = fingerprint(readOrNull(path));
  }

  private changesOf(turn: Turn): Change[] {
    const changes: Change[] = [];
    for (const [path, tracked] of turn.files) {
      if (tracked.after === undefined) continue; // the call never finished
      if (!tracked.tooBig && tracked.after === fingerprint(tracked.before)) continue; // nothing changed
      const now = fingerprint(readOrNull(path));
      changes.push({
        path,
        kind: tracked.before === null && !tracked.tooBig ? "created" : "modified",
        conflict: now !== tracked.after,
        unrestorable: tracked.tooBig,
      });
    }
    return changes;
  }

  /** The newest prompt that changed any file, which is what /undo works on. */
  latest(): { label: string; at: Date; changes: Change[] } | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const changes = this.changesOf(this.turns[i]);
      if (changes.length > 0) return { label: this.turns[i].label, at: this.turns[i].at, changes };
    }
    return null;
  }

  /** Every remembered prompt that changed files, newest first. */
  history(): { label: string; at: Date; changes: Change[] }[] {
    return this.turns
      .map((turn) => ({ label: turn.label, at: turn.at, changes: this.changesOf(turn) }))
      .filter((entry) => entry.changes.length > 0)
      .reverse();
  }

  /** Puts back what the newest changed prompt changed, then forgets that prompt. */
  undoLatest(): UndoResult | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i];
      const changes = this.changesOf(turn);
      if (changes.length === 0) continue;
      const result: UndoResult = { restored: [], deleted: [], failed: [], skipped: [] };
      for (const change of changes) {
        const tracked = turn.files.get(change.path) as Tracked;
        if (change.unrestorable) {
          result.skipped.push(change.path);
          continue;
        }
        try {
          if (tracked.before === null) {
            rmSync(change.path, { force: true });
            result.deleted.push(change.path);
          } else {
            mkdirSync(dirname(change.path), { recursive: true });
            writeFileSync(change.path, tracked.before);
            result.restored.push(change.path);
          }
        } catch (err) {
          result.failed.push({ path: change.path, error: err instanceof Error ? err.message : String(err) });
        }
      }
      this.turns.splice(i, 1);
      if (this.current === turn) this.current = null;
      return result;
    }
    return null;
  }

  private bytes(): number {
    let total = 0;
    for (const turn of this.turns) for (const tracked of turn.files.values()) total += tracked.before?.length ?? 0;
    return total;
  }

  /** Drops the oldest prompts once there are too many, or they hold too much. */
  private forget(): void {
    while (this.turns.length > MAX_TURNS || (this.turns.length > 1 && this.bytes() > MAX_TOTAL_BYTES)) this.turns.shift();
  }
}
