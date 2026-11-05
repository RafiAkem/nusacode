import { test } from "node:test";
import assert from "node:assert/strict";
import { qrLines, qrMatrix } from "../lib/qr.ts";
import { isTailscaleAddress, lanIp, parseTailscaleIp, resolveHost, tailscaleIp } from "../lib/remote-network.ts";
import { describe, linkFor } from "../extensions/remote.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("the QR matrix is square, has a blank quiet zone, and finder patterns in the corners", () => {
  const matrix = qrMatrix("http://100.64.0.1:7842/?token=abc");
  const size = matrix.length;
  assert.ok(matrix.every((row) => row.length === size));
  assert.ok(matrix[0].every((cell) => !cell) && matrix.at(-1)!.every((cell) => !cell), "blank border");
  // The finder pattern is a 7x7 block with a dark outer ring; its top-left sits after the 3-module border.
  assert.ok(matrix[3].slice(3, 10).every(Boolean), "top ring of the top-left finder");
  assert.ok(matrix[3].slice(size - 10, size - 3).every(Boolean), "top ring of the top-right finder");
});

test("the QR is drawn two modules per line in half-blocks with explicit colors", () => {
  const matrix = qrMatrix("hello");
  const lines = qrLines("hello");
  assert.equal(lines.length, Math.ceil(matrix.length / 2));
  for (const line of lines) {
    assert.equal([...plain(line)].length, matrix.length);
    assert.ok(plain(line).split("").every((char) => char === "▀"));
    assert.ok(line.includes("\x1b[48;2;208;208;208m") || line.includes("\x1b[48;2;0;0;0m"));
    assert.ok(line.endsWith("\x1b[0m"));
  }
});

test("a longer link still fits a terminal", () => {
  const lines = qrLines("http://192.168.100.200:7842/?token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  assert.ok(lines.length <= 25, `${lines.length} lines`);
  assert.ok([...plain(lines[0])].length <= 60);
});

test("Tailscale addresses are 100.64.0.0/10", () => {
  assert.equal(isTailscaleAddress("100.101.102.103"), true);
  assert.equal(isTailscaleAddress("100.64.0.1"), true);
  assert.equal(isTailscaleAddress("100.128.0.1"), false);
  assert.equal(isTailscaleAddress("192.168.1.5"), false);
});

test("tailscale ip output is read, and a missing CLI means no address", () => {
  assert.equal(parseTailscaleIp("100.101.102.103\n"), "100.101.102.103");
  assert.equal(parseTailscaleIp("192.168.0.4\n"), undefined);
  assert.equal(tailscaleIp(() => "100.99.88.77\n"), "100.99.88.77");
  assert.equal(tailscaleIp(() => { throw new Error("ENOENT"); }), undefined);
});

test("lanIp picks the Wi-Fi address and skips virtual adapters and public or loopback ones", () => {
  const v4 = (address: string, internal = false) => ({ family: "IPv4", address, internal }) as never;
  assert.equal(
    lanIp({
      Loopback: [v4("127.0.0.1", true)],
      "vEthernet (WSL)": [v4("172.20.0.1")],
      "Tailscale": [v4("100.88.1.1")],
      "Wi-Fi": [v4("192.168.1.42")],
    }),
    "192.168.1.42",
  );
  assert.equal(lanIp({ Ethernet: [v4("8.8.4.4")] }), undefined);
  assert.equal(lanIp({}), undefined);
});

test("resolveHost explains what is missing", () => {
  assert.deepEqual(resolveHost("local"), { host: "127.0.0.1" });
  assert.deepEqual(resolveHost("tailscale", { tailscale: () => "100.70.0.2", lan: () => undefined }), { host: "100.70.0.2" });
  assert.match((resolveHost("tailscale", { tailscale: () => undefined, lan: () => "192.168.1.2" }) as { error: string }).error, /Tailscale isn't running/);
  assert.deepEqual(resolveHost("lan", { tailscale: () => undefined, lan: () => "192.168.1.2" }), { host: "192.168.1.2" });
  assert.match((resolveHost("lan", { tailscale: () => undefined, lan: () => undefined }) as { error: string }).error, /Wi-Fi or Ethernet/);
});

const server = { url: "http://100.70.0.2:7842/?token=tok", token: "tok", clients: () => 2 } as never;

test("linkFor uses your own address when NUSACODE_REMOTE_URL is set", () => {
  assert.equal(linkFor(server, undefined), "http://100.70.0.2:7842/?token=tok");
  assert.equal(linkFor(server, "https://my-pc.tail1234.ts.net/"), "https://my-pc.tail1234.ts.net/?token=tok");
});

test("over Tailscale or the LAN the message shows a QR code; local does not", () => {
  const tailnet = describe(server, "tailscale", undefined);
  assert.ok(tailnet.includes("http://100.70.0.2:7842/?token=tok") && tailnet.includes("▀") && tailnet.includes("Scan it with your phone"));
  assert.ok(tailnet.includes("2 pages connected") && tailnet.includes("Tailscale account"));
  const lan = describe(server, "lan", undefined);
  assert.ok(lan.includes("▀") && lan.includes("plain HTTP"));
  const local = describe(server, "local", undefined);
  assert.ok(!local.includes("▀") && local.includes("this computer only") && local.includes("/remote lan"));
  const proxied = describe(server, "local", "https://pc.example.net");
  assert.ok(proxied.includes("https://pc.example.net/?token=tok") && proxied.includes("▀"));
});
