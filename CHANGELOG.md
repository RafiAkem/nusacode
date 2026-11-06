# Changelog

## [Unreleased]

### Added
- The welcome screen says when a newer NusaCode is on npm, with the command to update. It asks npm at most once a day, never delays startup, and stays quiet offline or with `NUSACODE_NO_UPDATE_CHECK=1`.
- NusaCode's screens can be shown in Bahasa Indonesia: pick it in `/setup` or with `/language`. English stays the default. It covers NusaCode's own text (setup, welcome screen, footer, `/usage` and the other NusaCode commands); pi's built-in screens and what the agent replies in are unchanged.
- Models that take images are marked `(vision)` in `/model`. A `model-capabilities.json` in the NusaCode home sets vision, maximum output and context window per model.
- `/budget` sets a spending limit for the session, with a warning at 80% and a stop at 100%, and a warning for any single prompt that costs too much. `--default` keeps a limit for new sessions.
- `/usage` shows today's and this month's spending across sessions, and `/usage history` breaks it down per day and per model. History is kept in `usage.jsonl` in the NusaCode home: model names, token counts and costs only.
- A large message now shows what it will cost to send, and asks first when that is Rp 500 or more (`NUSACODE_CONFIRM_ABOVE` changes it). Starting several subagents at once shows the likely total.
- `/plan` (or `alt+m`, or `--plan`) puts the agent in read-only plan mode, and `/plan ask` makes it ask before every file change and command.
- `/undo` puts back the files the agent changed in its last prompt, and `/undo list` shows what can be undone. It covers the agent's own `write` and `edit` tools, not shell commands or subagents.

### Changed
- 17 of NusaGate's 21 models are now marked `(vision)` instead of one, each checked with a test image through the gateway. Only DeepSeek V4 Pro, GLM 5.3, Qwen 3.8 27B and Qwen 3.8 Max are text-only. A vision flag in NusaGate's catalog is used if one is added.
- `/setup` is now one full-screen wizard. It opens with the N forming and a light drawing NusaGate's halo around it, then asks which language NusaCode should use, redrawing itself in each one as you move between them. The API key step shows your balance, a new step picks the default model, showing each one's context window, price in rupiah and dollars, and whether it takes images, the import step is a checklist, and a closing screen sums up what was set. `/import-config` uses the same checklist.
- `nusacode --version` prints both the NusaCode and the pi version.
- Learned skills are now proposed, not saved straight into use: `/skills review` shows each one (a diff for an update, and notes on anything risky) and only an approved skill loads. Set `NUSACODE_AUTO_APPROVE_SKILLS=1` to keep the old behavior.

### Fixed
- The welcome screen showed v0.1.0 whatever version was installed.

## [0.1.0] - 2026-11-06

First public release.

### Added
- Rupiah cost tracking for every response, with balance, tokens, cache hit rate and speed in the footer and `/usage`.
- `/sessions` to switch session in one step, `/topup`, `/setup` and `/import-config`.
- Tool calls drawn as cards, with syntax-highlighted red and green diffs for `write` and `edit`.
- An `ask` tool that shows a multiple-choice questions panel.
- Image attachments: paste an image or a file path, preview it above the prompt box, and enlarge it with `alt+i`.
- `/thinking` levels for DeepSeek models.
- Learned skills, subagents through the `task` tool, and token-saving defaults.
- Dark and light themes, and a startup screen.

### Changed
- `/bug` opens a GitHub issue with your version and environment filled in. It no longer uploads anything.
- `/changelog` shows this file.
- The window title reads `NSC - <session name>`.
