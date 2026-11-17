import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { codeFrom, connectUrl, exchangeCode, listenForRedirect, makePkce } from "../lib/login.ts";

test("PKCE challenge is S256 of the verifier", () => {
  const p = makePkce();
  assert.equal(p.challenge, createHash("sha256").update(p.verifier).digest("base64url"));
  assert.match(p.challenge, /^[A-Za-z0-9_-]{43}$/);
  const url = new URL(connectUrl("https://nusagate.com", "http://127.0.0.1:9/callback", p));
  assert.equal(url.pathname, "/dashboard/connect");
  assert.equal(url.searchParams.get("code_challenge"), p.challenge);
  assert.equal(url.searchParams.get("callback_url"), "http://127.0.0.1:9/callback");
  assert.equal(url.searchParams.get("app"), "NusaCode");
});

test("codeFrom checks state and reports a cancel", () => {
  assert.equal(codeFrom("http://127.0.0.1:9/callback?code=abc&state=s1", "s1"), "abc");
  assert.equal(codeFrom("  abc  ", "s1"), "abc");
  assert.throws(() => codeFrom("http://127.0.0.1:9/callback?code=abc&state=other", "s1"), /did not match/);
  assert.throws(() => codeFrom("http://127.0.0.1:9/callback?error=access_denied&state=s1", "s1"), /cancelled/);
});

test("loopback listener resolves with the browser's redirect", async () => {
  const l = await listenForRedirect();
  try {
    assert.match(l.callback, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const res = await fetch(`${l.callback}?code=c1&state=s1`);
    assert.equal(res.status, 200);
    assert.equal(codeFrom(await l.redirect, "s1"), "c1");
  } finally {
    l.close();
  }
});

test("the listener also answers on [::1], where a rewritten localhost callback can land", async (t) => {
  const l = await listenForRedirect();
  try {
    const port = new URL(l.callback).port;
    const res = await fetch(`http://[::1]:${port}/callback?code=c2&state=s2`).catch(() => null);
    if (!res) return t.skip("no IPv6 loopback on this machine");
    assert.equal(res.status, 200);
    assert.equal(codeFrom(await l.redirect, "s2"), "c2");
  } finally {
    l.close();
  }
});

test("exchangeCode returns the key or the gateway's message", async () => {
  let seen: unknown;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen = JSON.parse(body);
      const good = (seen as { code: string }).code === "good";
      res.writeHead(good ? 201 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(good ? { apiKey: "nsk_test" } : { error: "invalid_grant", message: "Code tidak valid" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(await exchangeCode(site, "good", "v".repeat(43)), "nsk_test");
    assert.deepEqual(seen, { code: "good", code_verifier: "v".repeat(43), app: "NusaCode" });
    await assert.rejects(exchangeCode(site, "bad", "v".repeat(43)), /Code tidak valid/);
  } finally {
    server.close();
  }
});
