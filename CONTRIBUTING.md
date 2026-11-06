# Contributing to NusaCode

Thanks for helping out. Bug reports, fixes, features and documentation are all welcome.

For anything large, please open an issue first so we can agree on the approach before you put in the work.

## Getting set up

You need [Node.js](https://nodejs.org) 22.19 or newer.

```sh
git clone https://github.com/RafiAkem/nusacode.git
cd nusacode
npm install
npm test
```

To run your checkout, use `npm start` (you'll need a [NusaGate](https://nusagate.com) API key, or
[your own provider](README.md#using-other-providers)).

To keep your own setup out of your testing, point NusaCode at a throwaway home:

```sh
NUSACODE_HOME=/tmp/nusacode-dev npm start
```

## How the code is organized

NusaCode is a launcher plus a [pi](https://github.com/earendil-works/pi) package. It doesn't patch pi; everything
is done through pi's extension API.

```text
bin/nusacode.js                  launcher: seeds config, then runs pi
config/                          default settings, provider and subagent definitions
pack/extensions/                 every file here is loaded as a pi extension
  brand.ts                       welcome screen, status bar, tool activity text
  meter.ts                       rupiah cost meter, /usage, /topup
  models.ts                      /model list from NusaGate's catalog
  setup.ts                       first-time setup, /setup, /import-config
  learn.ts                       automatic skills, /skills
  token-saver.ts                 cache guard, output truncation, thinking routing
  subagents.ts                   task tool
pack/lib/                        shared code that isn't an extension
pack/themes/                     nusagate-dark and nusagate-light themes
pack/test/                       tests
docs/                            README images
```

Every file in `pack/extensions/` must export an extension, so put helpers in `pack/lib/`.

## Tests

```sh
npm test
```

Tests use `node:test` and `node:assert/strict`, with no framework and no extra dependencies. They run against a
fake `pi` object and a stubbed `fetch`, so they need no network, API key or spending.

Please add a test with any behavior change. Pull requests run the suite automatically on Node 22 and 24, on Linux and
Windows.

For changes to the TUI, also run it and look at it: the tests can't tell you whether it looks right. Try a narrow
and a short terminal too.

## Guidelines

- **User-facing text is in English,** including commands, messages and docs.
- **Don't hardcode prices.** They come from NusaGate's catalog.
- **Paid features need a cost guard.** Anything that makes a model call on its own needs a limit, and its usage has
  to reach the meter.
- **Treat transcripts and tool output as untrusted.** They can contain secrets and hostile instructions. See how
  `learn.ts` handles them before writing anything that stores or acts on them.
- **Prefer pi's extension API** over depending on pi's internals, so upgrades stay easy. If you must rely on an
  internal, say why in a comment.
- **Keep dependencies out** unless they really earn their place.
- **Be careful with redraws.** In `regular` mode, pi clears the screen when a line above the viewport changes, so
  anything animated has to stop before it scrolls off.

## Upgrading pi

The pi version is pinned in `package.json`, so an upgrade is its own deliberate change. Read pi's changelog for
breaking changes, run the tests, and run a real session, including a `task` call and first-time setup.

You don't have to find out by trying. Every Monday the [Check the newest pi](.github/workflows/pi-upgrade.yml) workflow
installs pi's newest release without saving it, checks that each source patch in `scripts/pi-build.cjs` still applies
and would reach the code pi actually starts (`node scripts/check-pi-patches.cjs` does the same locally, and names every
patch that fails), and runs the tests. Today that check fails on the pinned pi 1.5.0 itself: it starts from
`dist/bundle/cli.js`, which the patches don't change. If that
fails it opens one issue, "pi X breaks NusaCode". If it passes, its summary says so.

`pack/test/smoke.test.ts` is part of that: it runs the real app against a small local server that pretends to be a model,
with every extension loaded and a tool call in the middle, so an upgrade that breaks something an extension relies on
fails there even though the unit tests, which use a fake pi, can't see it.

## Pull requests

1. Fork the repo and branch from `main`.
2. Keep each PR to one change, and explain what it does and why.
3. Make sure `npm test` passes.
4. For visual changes, include a screenshot or recording. Hide your real balance, API keys and session names.

Commit messages are short imperative sentences, such as `Fix the balance row on narrow terminals`.

Every push to `main` that changes code is published to [npm](https://www.npmjs.com/package/nusacode) as the next
patch version. For a minor or major release, raise `version` in `package.json` in the same change.

## Reporting bugs

[Open an issue](https://github.com/RafiAkem/nusacode/issues/new/choose) with your OS, terminal, Node version and the
steps to reproduce. Remove any API keys from logs and screenshots first.

## Security

Please don't report security problems in a public issue. Email [nusagate@rafiakem.tech](mailto:nusagate@rafiakem.tech)
with the details instead.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
