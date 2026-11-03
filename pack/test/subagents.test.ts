import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  executionMode: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

const REPO_AGENTS = join(import.meta.dirname, "..", "..", "config", "agents");
const FRONTMATTER = (body: string) => `---\nname: alpha\nmodel: m/x\ntools: read, grep, ls\n---\n${body}`;

/**
 * loadAgents() is called at registration (description) and at execute time, so
 * PI_CODING_AGENT_DIR must be set before the dynamic import.
 */
async function loadWith(t: { after: (fn: () => void) => void }, env: Record<string, string>, query: string) {
  const saved = { NUSACODE_SUBAGENT: process.env.NUSACODE_SUBAGENT, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const handlers: { def?: ToolDef } = {};
  const pi = {
    registerTool(def: ToolDef) {
      handlers.def = def;
    },
    events: { on: () => {} },
  };
  const mod = await import(`../extensions/subagents.ts?${query}`);
  mod.default(pi as unknown as ExtensionAPI);
  return handlers.def;
}

test("NUSACODE_SUBAGENT=1 registers no tool (recursion guard)", async (t) => {
  const def = await loadWith(t, { NUSACODE_SUBAGENT: "1", PI_CODING_AGENT_DIR: join(tmpdir(), "definitely-missing") }, "sa-off");
  assert.equal(def, undefined);
});

test("tool contract: name task, parallel fan-out, typebox schema, agents from disk", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nusacode-sa-"));
  const agents = join(dir, "agents");
  await mkdir(agents);
  await writeFile(join(agents, "alpha.md"), FRONTMATTER("Alpha body."), "utf8");
  t.after(async () => {
    // mkdtemp dirs are cleaned per test; a plain rm is enough on Windows too.
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });

  const def = await loadWith(t, { PI_CODING_AGENT_DIR: dir }, "sa-contract");
  assert.ok(def, "tool must be registered");
  assert.equal(def.name, "task");
  assert.equal(def.executionMode, "parallel", "fan-out is the point of the tool");
  assert.match(def.description, /Agents: alpha\./, "description embeds agents loaded from disk");

  // Typebox object schema: prompt required, agent optional.
  const schema = def.parameters;
  assert.equal(schema.type, "object");
  assert.ok(schema.properties && typeof schema.properties === "object");
  const props = schema.properties as Record<string, { type: string }>;
  assert.equal(props.prompt.type, "string");
  assert.equal(props.agent.type, "string");
  assert.deepEqual(schema.required, ["prompt"]);

  // Unknown agent: error result listing what IS available, no child process.
  const result = (await def.execute("t1", { agent: "nope", prompt: "x" })) as {
    isError: boolean;
    content: { text: string }[];
  };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Available: alpha/);
});

test("frontmatter contract: empty body and no frontmatter are rejected; repo agents listed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nusacode-sa2-"));
  const agents = join(dir, "agents");
  await mkdir(agents);
  await writeFile(join(agents, "empty-body.md"), FRONTMATTER(""), "utf8");
  await writeFile(join(agents, "raw.md"), "no frontmatter at all\njust text", "utf8");
  for (const file of await readdir(REPO_AGENTS)) await copyFile(join(REPO_AGENTS, file), join(agents, file));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });

  const def = await loadWith(t, { PI_CODING_AGENT_DIR: dir }, "sa-frontmatter");
  assert.ok(def);
  const result = (await def.execute("t2", { agent: "nope", prompt: "x" })) as { content: { text: string }[] };
  const text = result.content[0].text;
  for (const name of ["explorer", "researcher", "reviewer", "test-runner", "writer"]) {
    assert.match(def.description, new RegExp(`\\b${name}\\b`), `${name} must come from config/agents`);
    assert.match(text, new RegExp(`\\b${name}\\b`), `${name} must be loadable at execute time`);
  }
  // A valid frontmatter block with an empty body is not an agent; neither is a file without frontmatter.
  assert.doesNotMatch(text, /\bempty-body\b/);
  assert.doesNotMatch(text, /\braw\b/);
});
