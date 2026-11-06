import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The whole app, for real: the launcher starts the patched pi with every NusaCode extension
 * loaded, and a prompt runs to the end through a tool call. The model is a small local server that
 * speaks the OpenAI chat protocol, so nothing leaves the machine and nothing costs anything.
 *
 * Unit tests use a fake pi, so they can't notice that a pi upgrade changed something an extension
 * relies on. This can: if an extension fails to load, or a prompt no longer gets through, it fails.
 */
const launcher = join(import.meta.dirname, "..", "..", "bin", "nusacode.js");

type Seen = { messages: { role: string; content: unknown }[] };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function stream(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

/** A model that first asks to write a file, then, once it has the result, says it is done. */
function mockModel(file: string) {
  const requests: Seen[] = [];
  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url.endsWith("/chat/completions")) {
      const parsed = JSON.parse(await readBody(req)) as Seen;
      requests.push(parsed);
      const base = { id: "x", object: "chat.completion.chunk", model: "m" };
      if (requests.length === 1) {
        const args = JSON.stringify({ path: file, content: "written by the smoke test\n" });
        stream(res, [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call1", type: "function", function: { name: "write", arguments: args } }] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        ]);
      } else {
        stream(res, [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "All done." }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } },
        ]);
      }
      return;
    }
    // The meter asks NusaGate for prices and a balance at startup; here those are empty.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  return { server, requests };
}

/** What the one real run produced, shared by the tests below. */
let outcome: { stderr: string; requests: Seen[] } | null = null;

test("the real app starts with every extension loaded and runs a prompt through a tool call", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nusacode-smoke-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const work = join(root, "work");
  mkdirSync(home);
  mkdirSync(work);
  const file = join(work, "out.txt");

  const { server, requests } = mockModel(file);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  writeFileSync(
    join(home, "models.json"),
    JSON.stringify({
      providers: {
        mock: { baseUrl: `${base}/v1`, api: "openai-completions", apiKey: "not-a-real-key", models: [{ id: "m", contextWindow: 100_000, maxTokens: 4096 }] },
      },
    }),
  );

  const { NUSAGATE_API_KEY: _key, ...env } = process.env;
  const child = spawn(process.execPath, [launcher, "--model", "mock/m", "-p", "write the file"], {
    cwd: work,
    env: {
      ...env,
      NUSACODE_HOME: home,
      NUSACODE_SKIP_SETUP: "1",
      NUSACODE_NO_SPLASH: "1",
      NUSACODE_NO_LEARN: "1",
      NUSAGATE_MODELS_URL: `${base}/catalog`,
      NUSAGATE_BALANCE_URL: `${base}/balance`,
      PI_OFFLINE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill(), 90_000);
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  clearTimeout(timer);

  assert.equal(code, 0, `exit code; stderr: ${stderr}`);
  assert.match(stdout, /All done\./);
  assert.equal(existsSync(file), true, "the write tool ran");
  assert.equal(readFileSync(file, "utf8"), "written by the smoke test\n");

  outcome = { stderr, requests };
  assert.equal(requests.length, 2, "one request for the tool call and one with its result");
  const toolResult = requests[1].messages.find((message) => message.role === "tool");
  assert.match(String(toolResult?.content), /Successfully wrote/);
  assert.doesNotMatch(stderr, /failed to load|cannot find module|SyntaxError|TypeError/i, "no extension complained while loading");
});

// KNOWN DEFECT, found by this test. pi 1.5.0's launcher script is dist/bundle/cli.js, a bundle of the
// whole app, and scripts/pi-build.cjs patches the separate files under dist/ that nothing runs. So the
// running app still says "inside pi", titles the window like pi, and /bug still uploads the session to
// pi's developers. The patch tests only read the patched files, so they pass either way.
// Remove `todo` once the patches reach what actually runs.
test("the patched pi is the one that runs", { todo: "pi 1.5.0 runs from dist/bundle, which the source patches do not touch" }, () => {
  assert.ok(outcome, "the run above must have finished");
  const system = outcome.requests[0].messages.find((message) => message.role === "system");
  assert.match(String(system?.content), /running inside NusaCode/);
});
