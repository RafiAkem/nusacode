/**
 * End-to-end encryption for the relay.
 *
 * The relay only ever carries these frames, so it can neither read nor change a session. The
 * key travels in the link's # part, which a browser never sends to a server, and anything
 * that does not decrypt with it is dropped.
 *
 * Frame: 12 random bytes of IV, then AES-256-GCM of the JSON message. The first byte of the
 * additional data says which way the frame travels, so a frame from the phone cannot be
 * replayed back to it as if it came from the agent.
 *
 * The phone page carries a copy of these few functions (see remote-page.ts); a test runs both
 * against each other.
 */

export const TO_VIEWER = 1; // agent -> phone
export const TO_AGENT = 2; // phone -> agent

const subtle = globalThis.crypto.subtle;

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

export function randomId(bytes = 16): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A fresh 256-bit key, as base64url for the link. */
export function newKey(): string {
  return randomId(32);
}

/** The relay is given this instead of the secret, so it can recognise the agent without being able to be it. */
export async function proofOf(secret: string): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(`nusacode-relay-proof:${secret}`));
  return toBase64Url(new Uint8Array(digest));
}

async function importKey(key: string): Promise<CryptoKey> {
  const raw = fromBase64Url(key);
  if (raw.length !== 32) throw new Error("bad key");
  return subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(key: string, direction: number, message: unknown): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(message));
  const body = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: new Uint8Array([direction]) }, await importKey(key), plain));
  const frame = new Uint8Array(iv.length + body.length);
  frame.set(iv, 0);
  frame.set(body, iv.length);
  return frame;
}

/** The message in a frame, or undefined when it is not ours, is damaged, or travels the wrong way. */
export async function open(key: string, direction: number, frame: ArrayBuffer | Uint8Array): Promise<unknown | undefined> {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.length < 12 + 16) return undefined;
  try {
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new Uint8Array([direction]) },
      await importKey(key),
      bytes.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return undefined;
  }
}
