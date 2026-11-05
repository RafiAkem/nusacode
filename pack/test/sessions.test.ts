import { test } from "node:test";
import assert from "node:assert/strict";
import { choiceLabel, matches, parseArgs, pickable } from "../extensions/sessions.ts";

const now = new Date("2026-01-01T12:00:00Z");
const make = (over: Record<string, unknown> = {}) => ({
  path: "/s/a.jsonl",
  cwd: "/home/me/proj",
  name: undefined as string | undefined,
  firstMessage: "fix the meter bug",
  messageCount: 12,
  modified: new Date("2026-01-01T11:57:00Z"),
  allMessagesText: "fix the meter bug and the auth flow",
  ...over,
});

test("parseArgs reads the all keyword and the filter words", () => {
  assert.deepEqual(parseArgs(""), { all: false, query: "" });
  assert.deepEqual(parseArgs("Auth Bug"), { all: false, query: "auth bug" });
  assert.deepEqual(parseArgs("all auth"), { all: true, query: "auth" });
});

test("matches needs every word, in the name or the transcript", () => {
  assert.ok(matches(make(), "auth meter"));
  assert.ok(!matches(make(), "auth banana"));
  assert.ok(matches(make({ name: "Billing work" }), "billing"));
});

test("choiceLabel shows label, size and age, plus the folder across folders", () => {
  assert.equal(choiceLabel(1, make(), now, false), "1. fix the meter bug · 12 msgs · 3m ago");
  assert.equal(choiceLabel(2, make({ messageCount: 1 }), now, true), "2. fix the meter bug · 1 msg · 3m ago · proj");
});

test("pickable drops the open session and sorts newest first", () => {
  const older = make({ path: "/s/b.jsonl", modified: new Date("2026-01-01T09:00:00Z") });
  const open = make({ path: "/s/open.jsonl" });
  const result = pickable([older, open, make()], "/s/open.jsonl", "");
  assert.deepEqual(result.map((s) => s.path), ["/s/a.jsonl", "/s/b.jsonl"]);
});
