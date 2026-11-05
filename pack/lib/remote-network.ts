/**
 * Which address the remote page should listen on, so a phone can reach it.
 *
 *   local      127.0.0.1: this computer only
 *   tailscale  this computer's Tailscale address: reachable only from your own devices,
 *              over an encrypted, authenticated network
 *   lan        this computer's Wi-Fi/Ethernet address: reachable by anything on that network,
 *              over plain HTTP
 */
import { execFileSync } from "node:child_process";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type Mode = "local" | "tailscale" | "lan";

/** Adapters that are not the network your phone is on. */
const VIRTUAL = /vethernet|wsl|docker|vmware|virtualbox|vbox|hyper-v|loopback|tailscale|zerotier|bluetooth|br-|veth/i;

const PRIVATE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/** Tailscale addresses are in 100.64.0.0/10. */
export function isTailscaleAddress(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export function parseTailscaleIp(output: string): string | undefined {
  return output
    .split(/\s+/)
    .map((word) => word.trim())
    .find((word) => /^\d+\.\d+\.\d+\.\d+$/.test(word) && isTailscaleAddress(word));
}

/** This computer's Tailscale IPv4 address, or undefined when Tailscale is missing or down. */
export function tailscaleIp(run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { timeout: 2500, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })): string | undefined {
  for (const command of ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"]) {
    try {
      const found = parseTailscaleIp(run(command, ["ip", "-4"]));
      if (found) return found;
    } catch {
      // not installed there, or not running
    }
  }
  return undefined;
}

/** The first private IPv4 address on a real adapter, or undefined. */
export function lanIp(interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces()): string | undefined {
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal && PRIVATE.test(info.address)) return info.address;
    }
  }
  return undefined;
}

/** The address to bind and how to describe it, or why it can't be done. */
export function resolveHost(mode: Mode, lookups = { tailscale: tailscaleIp, lan: lanIp }): { host: string } | { error: string } {
  if (mode === "local") return { host: "127.0.0.1" };
  if (mode === "tailscale") {
    const host = lookups.tailscale();
    return host ? { host } : { error: "Tailscale isn't running on this computer. Install it from tailscale.com and sign in, or use /remote lan." };
  }
  const host = lookups.lan();
  return host ? { host } : { error: "Couldn't find a Wi-Fi or Ethernet address on this computer." };
}
