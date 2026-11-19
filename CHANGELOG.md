# Changelog

## 0.2.0 (2026-11-19)

- Status band (a mod): one row per running subsession directly above the prompt, in the terminal and the desktop app. It shows the state (busy, idle, question, waiting for permission, done), the protocol step, the current action, the time on the task, the cost, the context used and the process memory. Nothing is drawn while no subsession runs.
- Protocol: the subsession now sends each `progress:` line right after that step, in its own tool call. Before, it could send all of them together at the end, so none arrived live.

## 0.1.0 (2026-11-19)

- First version: `claude-sub` (start, list, stop, show, screen) and the `subsession` skill.
