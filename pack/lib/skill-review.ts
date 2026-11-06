/**
 * Helpers for reviewing a learned skill before it is allowed to load.
 *
 * A skill's text goes to the model in every later session, so a skill that says the wrong thing
 * keeps saying it. These helpers show a person what changed and what looks risky. They are aids
 * for reading, not a guarantee: the decision is theirs.
 */

type Op = { kind: " " | "+" | "-"; text: string };

/** Lines that differ, found with a longest-common-subsequence table. Skill texts are a few hundred lines at most. */
function diffOps(before: string[], after: string[]): Op[] {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const common: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      common[i][j] = before[i] === after[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: " ", text: before[i] });
      i++;
      j++;
    } else if (common[i + 1][j] >= common[i][j + 1]) {
      ops.push({ kind: "-", text: before[i++] });
    } else {
      ops.push({ kind: "+", text: after[j++] });
    }
  }
  while (i < before.length) ops.push({ kind: "-", text: before[i++] });
  while (j < after.length) ops.push({ kind: "+", text: after[j++] });
  return ops;
}

const CONTEXT_LINES = 1;

/**
 * What changed between two texts: `- ` for removed lines, `+ ` for added ones, and one line of
 * unchanged text around each change. Long unchanged stretches become `  ...`.
 */
export function lineDiff(before: string, after: string): string[] {
  const ops = diffOps(before.split("\n"), after.split("\n"));
  const near = ops.map((op, index) => {
    if (op.kind !== " ") return true;
    for (let d = 1; d <= CONTEXT_LINES; d++) {
      if (ops[index - d]?.kind !== undefined && ops[index - d].kind !== " ") return true;
      if (ops[index + d]?.kind !== undefined && ops[index + d].kind !== " ") return true;
    }
    return false;
  });
  const lines: string[] = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!near[index]) {
      skipped = true;
      return;
    }
    if (skipped && lines.length > 0) lines.push("  ...");
    skipped = false;
    lines.push(`${op.kind} ${op.text}`);
  });
  return lines.length > 0 ? lines : ["  (no change)"];
}

const RISKS: [RegExp, string][] = [
  [/https?:\/\/\S+/i, "contains a web address"],
  [/\b(?:curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(?:sh|bash|zsh|iex|invoke-expression)\b/i, "pipes a download into a shell"],
  [/\b(?:sudo|runas)\b/i, "asks for elevated rights"],
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\bremove-item\b[^\n]*-recurse|\bformat\s+[a-z]:/i, "deletes files recursively"],
  [/\b(?:eval|invoke-expression|iex)\b/i, "runs code built at run time"],
  [
    /ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|rules)|disregard (?:the )?(?:system|previous)|(?:do not|don't) (?:tell|inform|mention)[^.\n]*(?:user|human)|without (?:telling|asking) the user/i,
    "tries to override instructions or hide things from you",
  ],
  [/\b(?:password|passwd|api[_ -]?key|token|secret|credential)s?\b|\.ssh\b|id_rsa|\.env\b/i, "mentions credentials or secret files"],
  [/\bbase64\b|(?:\\x[0-9a-f]{2}){3,}|(?:%[0-9a-f]{2}){4,}/i, "contains encoded text"],
  [/\bgit\s+push\b[^\n]*(?:--force|-f\b)|\bgit\s+reset\s+--hard/i, "force-pushes or hard-resets git history"],
];

/** Things in a skill worth a closer look, in plain words. Empty does not mean safe. */
export function riskNotes(text: string): string[] {
  return RISKS.filter(([pattern]) => pattern.test(text)).map(([, note]) => note);
}
