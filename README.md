# NusaCode

A coding agent CLI for NusaGate, built on `pi` (`@earendil-works/pi-coding-agent`, MIT), with
extensions for a cost meter, token saving, subagents and learning. MIT licensed.

## Install

Requires Node.js >= 22.19.0 (see `engines` in `package.json`).

```sh
npm install
npm start
```

The first run asks for your NusaGate API key and offers to import from other coding agents.
You can also set `NUSAGATE_API_KEY` yourself.

The package isn't published to npm yet, so NusaCode runs from a checkout; `npx nusacode` only
works inside the repo directory. You can also run the launcher directly:

```sh
node bin/nusacode.js
```

All arguments pass through to `pi`, including `--version`, which therefore reports pi's version
(currently 1.4.0), not this package's (0.1.0).

## First-time setup

Setup runs once, on your first new session, and has two steps:

1. **API key:** if none is configured, it asks for one, checks it against NusaGate, and stores it
   in `auth.json` in the NusaCode home.
2. **Import:** for each of Claude Code, Codex, oh-my-pi, pi and OpenCode that it finds, it asks
   whether to copy that agent's skills and global instructions.

Import never overwrites anything. It skips dot folders (agents keep deleted skills in places like
`skills/.trash`), dot files, symlinks, and skills over 5 MB. It does not copy API keys or MCP
servers: those hold secrets and start processes. Imported files load in your sessions, so only
import from agents you trust. They apply from your next session.

`/setup` runs it again, `/import-config` runs only the import, and `NUSACODE_SKIP_SETUP=1` skips
the automatic run.

## Configuration

On first run, the launcher copies the default configuration into the home directory:
`NUSACODE_HOME`, or `~/.nusacode` if that isn't set.

```text
~/.nusacode/
  settings.json          # from config/settings.default.json
  models.json            # from config/models.json
  agents/*.md            # from config/agents/
  skills/                # imported and learned skills
  sessions/              # session history
```

Copying uses `COPYFILE_EXCL`, so existing files are never replaced when a new version runs. An
existing `settings.json` gains any new default keys, and values you already have stay as they are.
The home directory is used as `PI_CODING_AGENT_DIR`, and sessions are stored through `--session-dir`.

The default screen mode is `regular`, so your terminal handles scrolling. pi's `fullscreen` mode
uses the alternate screen, and on Windows the console host can drop its mouse tracking request, which
turns the wheel into arrow keys. Thinking blocks start collapsed: `ctrl+t` expands them and `ctrl+o`
expands tool output.

The default provider and model come from `config/models.json` and `config/settings.default.json`:
provider `nusagate`, `"baseUrl": "https://api.nusagate.com/v1"`, `"api": "openai-completions"`,
`"apiKey": "$NUSAGATE_API_KEY"`, model `deepseek-v4.1-flash` (contextWindow 1048576, maxTokens 16384).

The `/model` list comes from NusaGate's catalog and is cached in `nusagate-models.json`, so a saved
model still resolves at startup before the network finishes. The catalog has no capability fields,
so every model uses the same limits as `models.json`: text input and no thinking parameter.

`NUSAGATE_MODELS_URL` overrides the catalog URL; the meter reads it at session start and defaults
to `https://api.nusagate.com/api/public/models`.

## Commands

| Command | Description |
| --- | --- |
| `/usage` | Show the session cost meter (rupiah, tokens, savings, speed) |
| `/topup` | Show your balance and a NusaGate top-up link |
| `/skills` | List automatically learned skills; `/skills delete <name>` deletes one |
| `/setup` | Run first-time setup again |
| `/import-config` | Import skills and instructions from other coding agents |

## The `task` subagent

The `task` tool delegates one self-contained job to a separate `pi` process with its own context
window, in the same working directory. The child can't see the parent's conversation, so the prompt
must contain every fact it needs.

Available agents, each with a model and tool list in its frontmatter: `explorer` (default),
`researcher`, `reviewer`, `test-runner`, `writer`.

Children run with `--no-session` and a `--tools` allowlist from the agent definition, so recursion is
closed structurally: the allowlist never contains `task`, the extension pack isn't loaded
(`--no-extensions`), and the child's environment carries `NUSACODE_SUBAGENT=1`. At most four children
run at once; the rest wait. Each child times out after `600_000` ms, which
`NUSACODE_SUBAGENT_TIMEOUT_MS` overrides.

## Cost meter

Tokens come from `usage` in the provider response; rupiah prices are fetched once per session from
NusaGate's public catalog. Each response uses the gateway's billing formula: input rate + output rate
+ cache hits (a percentage of the input rate), summed and rounded up per request (`Math.ceil`). No
price is hardcoded.

Balance comes from `GET https://api.nusagate.com/v1/balance` with the same API key, at session start
and on each `/usage` or `/topup`. `NUSAGATE_BALANCE_URL` overrides the URL. If the account has a monthly
pass, its remaining quota is shown too, and the top-up link appears in the report when the balance is
under Rp 5.000.

The full report only appears through `/usage`; the status bar always shows a summary. Speed (tok/s) is
output tokens divided by the time from the first streamed chunk to the end of the response, so waiting
for the model to start doesn't count.

## Automatic learning

After substantial work (at least 8 tool calls, or 4 if it recovered from an error), a background process
reads the transcript and decides whether there's a procedure worth keeping. If so, it writes a skill to
`~/.nusacode/skills/learned-<name>/SKILL.md`, which applies from the next session; loading it mid-session
would throw away the provider's prompt cache. Existing learned skills are improved when a session proves
them wrong or incomplete.

- **Cost:** each review is a paid model call, at most three per session, and its cost reaches the meter.
- **Security:** the review process has no tools, so text in a transcript can't make it act. Secrets are
  masked before reaching the model, and a skill that still looks like it holds one is refused. Only skills
  prefixed `learned-` can be touched.
- **Limits:** saved skills load in later sessions, and these checks can't guarantee a skill is free of
  harmful instructions. Review them with `/skills`.

`NUSACODE_NO_LEARN=1` turns this off.

## Token saver

Three levers, cheapest first:

1. **Cache prefix guard:** a fingerprint of the system prompt and tool list is computed on every request.
   A mid-session change invalidates the provider's cached prefix, so the meter warns once, without blocking
   or changing the payload.
2. **Tool output truncation:** `read` and `bash` results are capped at 200 lines. pi already caps them at
   2000 lines / 50KB, so this tightens the existing limit. `read` continues through `offset`, and `bash`
   keeps the tail (a summary plus an output pointer).
3. **Thinking routing:** the level comes from settings (`modelThinkingLevels` per model, then
   `defaultThinkingLevel`) and drops to `minimal` for short mechanical prompts while the session has no
   failed tool. An explicit `/think` choice wins.

`NUSACODE_NO_TOKEN_SAVER=1` turns all three off (used as an A/B switch). `NUSACODE_TRUNCATE_LINES=0` turns off
truncation; other values change the line limit.

Measured on `nusagate/deepseek-v4.1-flash` (M3, 2026-10-26), as recorded in the header of `token-saver.ts`:
the 200-line limit gave 100.5k vs 97.9k tokens on the same session (+2.7%), at the same cost of Rp 22; a
50-line limit saved 15.4% of tokens but hid output that should have been visible.

## Tests

Run tests with `npm test`. They use `node:test` and `node:assert/strict`, with no framework or extra
dependencies, and live in `pack/test/`.

- `brand.test.ts`: startup screen layout, narrow widths, halo frames, status bar, and tool activity text.
- `learn.test.ts`: when a review runs, secret masking, and skill name and body validation.
- `models.test.ts`: catalog to model list, the startup cache, and a corrupt catalog.
- `meter.test.ts`: rupiah arithmetic (rounding up per request, cache pricing and its fallback, models with
  no price, failed price fetches), speed, and the startup summary.
- `setup.test.ts`: finding and importing skills, what import refuses, and storing the API key.
- `token-saver.test.ts`: output truncation and the `offset` pointer, and the cache prefix warning.
- `subagents.test.ts`: `task` tool registration, the typebox schema, the recursion guard, and frontmatter
  parsing.

Extensions run against a fake `pi` object and a stubbed `fetch`, so tests need no network or API key.

## Repo layout

```text
bin/nusacode.js              launcher: seeds config, then runs pi
config/settings.default.json default provider, model and UI settings
config/models.json           nusagate provider definition
config/agents/*.md           five agent definitions for the task tool
pack/extensions/brand.ts     startup screen, status bar, and tool activity text
pack/extensions/meter.ts     rupiah cost meter, /usage and /topup
pack/extensions/models.ts    /model list from NusaGate's catalog
pack/extensions/setup.ts     first-time setup, /setup and /import-config
pack/extensions/learn.ts     automatic skills from finished work, and /skills
pack/extensions/token-saver.ts  cache guard, output truncation, thinking routing
pack/extensions/subagents.ts task tool and the child usage protocol
pack/themes/*.json           nusagate-dark and nusagate-light themes (nusagate.com's colors)
```

`pack/` is an npm workspace (`@nusacode/pack`), exposed as a pi-package through
`pi.extensions: ["./extensions"]`.

## License

MIT. See `LICENSE`. NusaCode uses `pi` (MIT, earendil-works) as an unmodified runtime dependency;
its attribution is in `NOTICE`. This project is not sponsored or endorsed by pi's maintainers.
