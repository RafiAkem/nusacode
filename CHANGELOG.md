# Changelog

## [Unreleased]

### Added
- Models that take images are marked `(vision)` in `/model`. A `model-capabilities.json` in the NusaCode home sets vision, maximum output and context window per model.
- `/budget` sets a spending limit for the session, with a warning at 80% and a stop at 100%, and a warning for any single prompt that costs too much. `--default` keeps a limit for new sessions.
- `/usage` shows today's and this month's spending across sessions, and `/usage history` breaks it down per day and per model. History is kept in `usage.jsonl` in the NusaCode home: model names, token counts and costs only.
- A large message now shows what it will cost to send, and asks first when that is Rp 500 or more (`NUSACODE_CONFIRM_ABOVE` changes it). Starting several subagents at once shows the likely total.
- `/plan` (or `alt+m`, or `--plan`) puts the agent in read-only plan mode, and `/plan ask` makes it ask before every file change and command.
- `/undo` puts back the files the agent changed in its last prompt, and `/undo list` shows what can be undone. It covers the agent's own `write` and `edit` tools, not shell commands or subagents.

### Changed
- `nusacode --version` prints both the NusaCode and the pi version.
- Learned skills are now proposed, not saved straight into use: `/skills review` shows each one (a diff for an update, and notes on anything risky) and only an approved skill loads. Set `NUSACODE_AUTO_APPROVE_SKILLS=1` to keep the old behavior.

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
