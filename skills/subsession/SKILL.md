---
name: subsession
description: Hand a long, tool-heavy task to a "subsession", a separate Claude Code session in Code Mode that this session starts in hidden tmux and talks to with SendMessage, while this session keeps Remote Control on. Use when the user says "/subsession", "use a subsession", "run this in Code Mode", "do it in a subsession", or asks for Code Mode while they are on the phone (Code Mode turns Remote Control off, so it cannot run in this session). Not for short tasks: a normal subagent is lighter.
---

# subsession: Code Mode work, driven from this session

## Purpose

Code Mode (Claude writes JavaScript that makes many tool calls in one step) saves round trips on long, tool-heavy tasks. It turns Remote Control off, so a session the user drives from the phone cannot use it. A subsession solves that: this session starts a second, interactive `claude` in Code Mode in hidden tmux, sends it the task with `SendMessage`, and relays its progress lines to the user.

A subagent cannot do this: it runs inside this session and follows this session's mode.

## Commands

| Command | What it does |
|---|---|
| `claude-sub start <folder> --yes [--name N] [--model M]` | starts the subsession and waits until Code Mode is on; prints JSON with `name` and `sessionId` |
| `claude-sub list` | running subsessions with `status` (busy / idle) |
| `claude-sub stop <name>` or `--all` | ends it |
| `claude-sub show <name>` | opens a terminal window attached to it, for the user at the computer |
| `claude-sub screen <name>` | prints the end of its screen; only when messages stop arriving |

At most 2 run at once (`CLAUDE_SUB_MAX`): each one is a full Claude Code process.

## Instructions

1. **Start.** `claude-sub start <folder> --yes --model sonnet` (use the model the task needs). `--yes` accepts the one-time Code Mode confirmation; the user asked for Code Mode by asking for a subsession. Read the `name` from the JSON. If it fails, pass the error on; do not retry the same way.
2. **Send the task** with `SendMessage` to that `name`, with `notify_when_idle: true`. The first line is a one-sentence summary. Then the task, the folder, what done means, and this protocol, word for word:

   ```
   Protocol: you are a subsession. Report to the sender (copy the `from` of this message as your `to`):
   - as soon as a step is finished, send one line: "progress: <step> (<n>/<total>)"
     Send it in its own tool call or code run, right after that step and before the next one starts.
     Never collect the progress lines and send them together at the end: they must arrive live.
   - at the end: "done: <result>", with the paths of anything you wrote
   - if you are stuck or need a decision: "question: <question>", then wait
   Do not ask the user directly: nobody watches your screen.
   ```

3. **Relay.** Each `progress:` message starts a turn here: tell the user in one short line ("Subsession: step 2/5, reading the files"). Do not poll `claude-sub list` or the screen in a loop: in the terminal, the status band above the prompt already shows each subsession live. If all the `progress:` lines of a task arrive at the same moment, the subsession batched them: remind it of the protocol in the next task.
4. **Questions.** For a `question:` line, answer it yourself when the user's request already answers it; otherwise ask the user and send the answer back.
5. **Check the result.** A `done:` message is a claim. Open the files, run the check, and say what you verified.
6. **Stop it.** `claude-sub stop <name>`, unless the user wants to send more tasks to it.

## Pitfalls

- **Permissions stay per session.** Never send a subsession work that was denied or blocked here.
- **Held messages:** if a `[Cross-session delivery notice]` says the message is held, the two sessions run in different permission modes. Tell the user; the subsession starts in the user's default mode.
- **No message for a long time:** run `claude-sub screen <name>` once to see why (a permission prompt, an error), then tell the user.
- **Resume:** a Code Mode session resumes only with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` set, and only in a terminal. The phone and desktop apps cannot open it.
- **Trust prompt:** a folder Claude never opened asks "trust this folder?". `start` stops and says so; the user must open `claude` there once.

## Requirements

- Claude Code v2.1.323 or later, native build, a Claude subscription or Console account, a supported model (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2).
- tmux. macOS or Linux.
- Cross-session messaging (v2.1.224 or later), on by default.

Docs: https://code.claude.com/docs/en/code-mode and https://code.claude.com/docs/en/cross-session-messaging
