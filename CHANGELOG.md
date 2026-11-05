# Changelog

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
