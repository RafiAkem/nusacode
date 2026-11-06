# NusaCode relay

A small server that lets a phone reach a NusaCode session from anywhere, with nothing to install or
open on your computer. NusaCode connects **out** to the relay, you scan a QR code, and the phone's
browser connects to the same relay. This is how `/remote` works over the internet.

It runs on [Cloudflare Workers](https://workers.cloudflare.com) and the free plan is enough for
personal use and a good number of users. You deploy it once.

## Deploy it

You need a free Cloudflare account and Node.js. From this folder:

```sh
cd relay
npx wrangler login
npx wrangler deploy
```

Wrangler prints your relay's address, something like `https://nusacode-relay.your-name.workers.dev`.
Open it in a browser to check: you should see a short "NusaCode relay" page.

## Use it

In NusaCode:

```
/remote relay https://nusacode-relay.your-name.workers.dev
```

NusaCode remembers the address, so from then on plain `/remote` uses the relay. It shows a link and
a QR code; scan it with your phone's camera. `/remote stop` ends the session.

To set the address another way, use the `NUSACODE_RELAY_URL` environment variable.

## What the relay can and can't see

Everything between NusaCode and your phone is encrypted end to end with AES-256-GCM.

- The key is made fresh for every `/remote` session and sits in the part of the link after the `#`.
  Browsers never send that part to a server, so the relay never receives it.
- The relay sees that a session exists, how big and how often the messages are, and when people
  connect. It cannot read them, change them, or answer for you: anything that doesn't decrypt with
  the key is dropped.
- A phone's messages carry a counter, so a copy replayed by the relay is ignored.
- The relay also remembers a hash of a secret that only your NusaCode holds, so nobody who merely
  has the link can take over the NusaCode end of a session.

Anyone who has the **full link** can read the session and send it messages, so treat it like a
password and run `/remote stop` when you're done.

## Limits

| | |
| --- | --- |
| Phones per session | 6 |
| Largest message | 512 KiB |
| Message rate | 40 at once, then 10 a second, per connection |
| Idle session | closed after 30 minutes without the agent sending anything |

NusaCode only builds and sends updates while a phone is connected, and sends only what changed.

## Cost

On Cloudflare's free plan you are never billed: if a daily limit is reached, requests fail until it
resets. A half-hour session is roughly 60 requests (incoming WebSocket messages count 1/20 of a
request each, and outgoing ones are free), so the 100,000 a day free allowance covers well over a
thousand sessions a day. The relay uses WebSocket hibernation, so an idle session costs no compute
time. Check [Cloudflare's pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/)
for the current numbers, and watch usage in your dashboard.

## Trying it on your own computer

```sh
npm install
node relay/dev-server.ts          # listens on http://127.0.0.1:8787
```

Then in NusaCode: `/remote relay http://127.0.0.1:8787`. The dev server runs the same code as the
Worker but speaks plain HTTP, so use it only for testing.

## How it fits together

- `src/index.ts`: the Worker. Serves the phone page and hands WebSocket connections to a room.
- `src/room.ts`: one Durable Object per session. Forwards encrypted frames, enforces the limits.
- `../pack/lib/relay-client.ts`: NusaCode's side. `../pack/lib/remote-page.ts`: the phone page.
- `../pack/lib/relay-crypto.ts`: the encryption, shared in spirit with the page (a test runs them
  against each other).
