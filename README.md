# subsessions

[![CI](https://github.com/lucas-saldanha-werneck/subsessions/actions/workflows/test.yml/badge.svg)](https://github.com/lucas-saldanha-werneck/subsessions/actions/workflows/test.yml)
[![License](https://img.shields.io/github/license/lucas-saldanha-werneck/subsessions)](LICENSE)

Run long tasks in Claude Code's [Code Mode](https://code.claude.com/docs/en/code-mode) from a session that keeps [Remote Control](https://code.claude.com/docs/en/remote-control) on.

Code Mode lets Claude write JavaScript that makes many tool calls in one step. It saves round trips on long, tool-heavy tasks. But a Code Mode session has no Remote Control, so you cannot use it from your phone. A subagent does not help: it runs inside your session and follows its mode.

A **subsession** is a second, interactive `claude` in Code Mode, started in hidden tmux. Your main session sends it the task with [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) (`SendMessage`). The subsession sends back one line per step and the result. Your main session shows you each line, on the phone too.

```
phone ──Remote Control──▶ main session ──SendMessage──▶ subsession (Code Mode, hidden tmux)
                              ▲                                │
                              └──── "progress: 2/3" / "done: …" ┘
```

## What is in it

- **`subsession` skill**: tells Claude when to use a subsession, the message protocol (`progress:`, `done:`, `question:`), and to check the result before calling it done.
- **`claude-sub`**: starts, lists, shows and stops subsessions.

| Command | What it does |
|---|---|
| `claude-sub start <folder> --yes [--name N] [--model M]` | starts a subsession and waits until Code Mode is on; prints JSON with its name |
| `claude-sub list` | running subsessions, busy or idle |
| `claude-sub stop <name>` / `--all` | ends them |
| `claude-sub show <name>` | opens a terminal window attached to it (macOS iTerm or Terminal) |
| `claude-sub screen <name>` | prints the end of its screen, for when messages stop |

`--yes` accepts the one-time Code Mode confirmation. Without it, `start` stops at that prompt.

## Install

```bash
claude plugin marketplace add lucas-saldanha-werneck/lucas-tools
claude plugin install subsessions@lucas-tools
```

Then ask Claude: "use a subsession to …", or type `/subsession`.

## Requirements

- Claude Code v2.1.323 or later (native build), with a model that supports Code Mode (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2). See the [Code Mode requirements](https://code.claude.com/docs/en/code-mode#requirements).
- tmux and Python 3.8+. macOS or Linux.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_SUB_MAX` | `2` | how many subsessions run at once (each is a full Claude Code process) |
| `CLAUDE_SUB_SOCKET` | `claude-sub` | tmux socket name, kept apart from your own tmux |
| `CLAUDE_SUB_TIMEOUT` | `90` | seconds `start` waits for Code Mode |
| `CLAUDE_SUB_CLAUDE` | `claude` on PATH | the claude binary to run |

## Limits

- You cannot see a subsession from the phone: Code Mode has no Remote Control. You see what the main session relays.
- It does not show in the subagent panel. `claude-sub list` shows busy or idle only.
- Each message counts toward usage like a typed prompt.
- A Code Mode session resumes only in a terminal with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`.
- Code Mode is experimental and can change in any Claude Code release.

## Tests

```bash
bash tests/run.sh
```

Unit tests, plus end-to-end tests that drive real tmux with a fake `claude`.

## License

MIT
