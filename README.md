<div align="center">

# NusaCode

**A coding agent for your terminal that shows what every prompt costs and learns from the work it does.**

Built for [NusaGate](https://nusagate.com), on top of [pi](https://github.com/earendil-works/pi).

[![License: MIT](https://img.shields.io/badge/license-MIT-4ed899?style=flat-square&labelColor=0f3a2a)](LICENSE)
[![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-4ed899?style=flat-square&labelColor=0f3a2a)](package.json)
[![Built on pi](https://img.shields.io/badge/built%20on-pi-4ed899?style=flat-square&labelColor=0f3a2a)](https://github.com/earendil-works/pi)

[Quick start](#quick-start) · [Features](#features) · [Commands](#commands) · [Configuration](#configuration) · [Contributing](#contributing)

<br>

<img src="docs/welcome.svg" alt="NusaCode's welcome screen: an ASCII N logo with an orbiting halo, key tips, usage and recent sessions" width="820">

<sub>The welcome screen, with sample data.</sub>

</div>

## Quick start

You need [Node.js](https://nodejs.org) 22.19 or newer and a [NusaGate](https://nusagate.com) API key.

```sh
git clone https://github.com/RafiAkem/nusacode.git
cd nusacode
npm install
npm start
```

The first run asks for your API key and offers to import skills from other coding agents. Then just
type what you want done.

> [!NOTE]
> NusaCode isn't on npm yet, so it runs from a checkout. To update, run `git pull && npm install`.

## See it in action

A first run: the setup splash, then NusaCode finds and fixes two real bugs in a small project, and `/usage` shows
what that cost. The session and its costs are real; only the balance is sample data.

<p align="center">
  <img src="docs/demo.gif" alt="A NusaCode first run: the setup splash, the welcome screen, the agent fixing two bugs, and /usage reporting the cost, tokens, cache hit rate and speed" width="820">
</p>

## Features

|  |  |
| --- | --- |
| **Real costs in rupiah** | Each response is priced with the gateway's own billing formula, using live prices. Your balance, cost, cache hit rate and speed stay in view. |
| **Every NusaGate model** | `/model` lists the live catalog: DeepSeek, GPT, Gemini, GLM, Grok, Kimi, MiniMax, Qwen and more. |
| **Learns as you work** | After substantial tasks, a background review can save what it learned as a reusable skill. |
| **Brings your setup with it** | Import skills and global instructions from Claude Code, Codex, oh-my-pi, pi and OpenCode. |
| **Spends fewer tokens** | Tool output is trimmed, thinking effort drops for simple prompts, and you're warned when something breaks the prompt cache. |
| **Delegates to subagents** | The `task` tool hands focused work to separate processes, so exploration stays out of your main conversation. |
| **Stays readable** | Thinking starts collapsed, and the spinner names what the agent is doing right now. |

## Commands

| Command | What it does |
| --- | --- |
| `/usage` | Show session cost, tokens, cache hit rate, speed and balance |
| `/topup` | Show your balance and a top-up link |
| `/model` | Switch model |
| `/skills` | List learned skills; `/skills delete <name>` removes one |
| `/import-config` | Import skills and instructions from other coding agents |
| `/setup` | Run first-time setup again |
| `/resume` | Continue an earlier session |

Start a message with `!` to run a shell command, or `!!` to run it without sending the output to the model.

| Key | Action |
| --- | --- |
| `ctrl+t` | Expand or collapse thinking |
| `ctrl+o` | Expand or collapse tool output |
| `ctrl+l` | Switch model |
| `escape` | Interrupt the agent |
| `ctrl+d` | Exit |

## How it works

<details>
<summary><strong>Cost meter</strong></summary>

<br>

Token counts come from the provider's response, and rupiah prices are fetched once per session from
NusaGate's public catalog. No price is hardcoded. Each response uses the gateway's billing formula: input
rate + output rate + cache hits (a percentage of the input rate), rounded up per request.

The status bar always shows a summary, and `/usage` shows the full report. Speed (tok/s) is output tokens
divided by the time from the first streamed chunk to the end of the response, so waiting for the model to
start doesn't count against it.

The saving against the vendor's list price compares fresh input and output tokens only. The catalog has no
official cache price, so cached tokens are left out on both sides.

</details>

<details>
<summary><strong>Automatic learning</strong></summary>

<br>

After substantial work (at least 8 tool calls, or 4 if it recovered from an error), a background process reads
the transcript and decides whether there's a procedure worth keeping. Most sessions teach nothing, and then
nothing is saved. If there is one, it's written to `~/.nusacode/skills/learned-<name>/SKILL.md` and applies
from your next session, because loading it mid-session would throw away the provider's prompt cache.

- **Cost:** each review is a paid model call, at most three per session, and its cost shows in the meter.
- **Safety:** the review has no tools, so text in a transcript can't make it act. Secrets are masked before
  they reach the model, and a skill that still looks like it holds one is refused. Only skills prefixed
  `learned-` can be touched.

> [!WARNING]
> Saved skills load in later sessions, and these checks can't guarantee a skill is free of harmful
> instructions. Secret detection is pattern-based too, so it can miss a plain-looking password. Review what it
> learns with `/skills`, or turn learning off with `NUSACODE_NO_LEARN=1`.

</details>

<details>
<summary><strong>First-time setup and import</strong></summary>

<br>

Setup runs once, on your first new session. If no API key is configured, it asks for one, checks it against
NusaGate, and stores it in `auth.json` in the NusaCode home. Then, for each agent it finds, it asks whether to
copy that agent's skills and global instructions.

Import never overwrites anything. It skips dot folders (agents keep deleted skills in places like
`skills/.trash`), dot files, symlinks, and skills over 5 MB. It doesn't copy API keys or MCP servers, because
those hold secrets and start processes. Imported files load in your sessions, so only import from agents you
trust.

</details>

<details>
<summary><strong>Token saver</strong></summary>

<br>

1. **Cache prefix guard:** the system prompt and tool list are fingerprinted on every request. A mid-session
   change invalidates the provider's cached prefix, so the meter warns once, without blocking or changing the
   request.
2. **Tool output truncation:** `read` and `bash` results are capped at 200 lines, tightening pi's own limit of
   2000 lines / 50 KB. `read` continues through `offset`, and `bash` keeps the tail with a pointer to the rest.
3. **Thinking routing:** the level comes from settings (`modelThinkingLevels` per model, then
   `defaultThinkingLevel`) and drops to `minimal` for short mechanical prompts while the session has no failed
   tool. An explicit `/think` choice wins.

Measured on `nusagate/deepseek-v4.1-flash` (2026-10-26), as recorded in the header of `token-saver.ts`: the
200-line limit used 100.5k vs 97.9k tokens on the same session (+2.7%), at the same cost of Rp 22. A 50-line
limit saved 15.4% of tokens but hid output that should have been visible.

</details>

<details>
<summary><strong>Subagents</strong></summary>

<br>

The `task` tool delegates one self-contained job to a separate `pi` process with its own context window, in the
same working directory. The child can't see your conversation, so the prompt must hold every fact it needs.

Agents, each with a model and tool list in its frontmatter: `explorer` (default), `researcher`, `reviewer`,
`test-runner` and `writer`. They're copied to `~/.nusacode/agents/`, where you can edit them.

Recursion is closed structurally: the tool allowlist never contains `task`, the extension pack isn't loaded
(`--no-extensions`), and the child's environment carries `NUSACODE_SUBAGENT=1`. At most four children run at
once, and each times out after 10 minutes.

</details>

<details>
<summary><strong>Models</strong></summary>

<br>

The `/model` list comes from NusaGate's catalog and is cached in `nusagate-models.json`, so a saved model still
resolves at startup before the network finishes. The catalog has no capability fields, so every model currently
uses the same limits: text input, no thinking parameter, and 16,384 output tokens.

</details>

## Configuration

Everything lives in `~/.nusacode/`, or wherever `NUSACODE_HOME` points:

```text
~/.nusacode/
├── settings.json     your settings
├── models.json       provider definition
├── auth.json         API key, if you entered one during setup
├── AGENTS.md         global instructions, if imported
├── agents/           subagent definitions
├── skills/           imported and learned skills
└── sessions/         session history
```

Files are only seeded once and are never replaced. When a new version adds a default setting, it's added to your
`settings.json` without changing the values you already have.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `NUSAGATE_API_KEY` | API key, instead of entering it during setup |
| `NUSACODE_HOME` | Home directory (default `~/.nusacode`) |
| `NUSACODE_SKIP_SETUP=1` | Skip first-time setup |
| `NUSACODE_NO_SPLASH=1` | Skip the setup splash and confirmation screens |
| `NUSACODE_NO_LEARN=1` | Turn off automatic learning |
| `NUSACODE_NO_TOKEN_SAVER=1` | Turn off all token saving |
| `NUSACODE_TRUNCATE_LINES` | Tool output line limit; `0` turns off truncation |
| `NUSACODE_SUBAGENT_TIMEOUT_MS` | Per-subagent timeout (default `600000`) |
| `NUSAGATE_MODELS_URL` | Override the catalog URL |
| `NUSAGATE_BALANCE_URL` | Override the balance URL |

### Screen mode

NusaCode defaults to pi's `regular` screen mode, so your terminal handles scrolling and selection. To use pi's
fullscreen mode, with its in-app scrollbar and search, set `"tuiMode": "fullscreen"` in `settings.json`.

### pi commands

pi's `install`, `remove`, `list`, `config`, `auth` and `mcp` commands work through `nusacode` and use the NusaCode
home. `nusacode update` prints the update steps instead of running pi's updater, which would install a separate
global pi rather than the version this package pins. `--version` reports pi's version.

## Contributing

Issues and pull requests are welcome. NusaCode has mostly been run on Windows so far, so reports from macOS and
Linux are especially useful.

```sh
npm test
```

Tests use `node:test` with no framework or extra dependencies, and live in `pack/test/`. Extensions run against a
fake `pi` object and a stubbed `fetch`, so tests need no network or API key.

```text
bin/nusacode.js                  launcher: seeds config, then runs pi
config/                          default settings, provider and subagent definitions
pack/extensions/brand.ts         welcome screen, status bar, tool activity text
pack/extensions/meter.ts         rupiah cost meter, /usage, /topup
pack/extensions/models.ts        /model list from NusaGate's catalog
pack/extensions/setup.ts         first-time setup, /setup, /import-config
pack/extensions/learn.ts         automatic skills, /skills
pack/extensions/token-saver.ts   cache guard, output truncation, thinking routing
pack/extensions/subagents.ts     task tool
pack/themes/                     nusagate-dark and nusagate-light themes
```

`pack/` is an npm workspace (`@nusacode/pack`), exposed as a pi package.

## Acknowledgements

NusaCode runs on [pi](https://github.com/earendil-works/pi) by earendil-works, used unmodified as a runtime
dependency. Its attribution is in [NOTICE](NOTICE). NusaCode is an independent project, not made, sponsored or
endorsed by pi's maintainers.

## License

[MIT](LICENSE)
