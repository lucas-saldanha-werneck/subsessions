# Changelog

## 0.3.0 (2026-11-19)

- Each subsession gets a tab in the tmux session of the session that started it, named `⚙ <name>`. Selecting or clicking the tab shows the subsession's conversation; clicking the main window goes back. The tab opens in the background (the current window keeps the focus) and closes when the subsession stops, is killed or crashes. Nothing changes when the starting session is not in tmux. `CLAUDE_SUB_TAB=0` turns it off; `CLAUDE_SUB_TAB_PREFIX` changes the `⚙ `. `start` prints `"tab": true` when it opened one. Subsessions started before 0.3.0 have no tab: stop and start them again.

## 0.2.2 (2026-11-19)

- `claude-sub start` gives the subsession two variables: `CLAUDE_SUB_NAME` (its name) and `CLAUDE_SUB_PARENT` (the pid of the session that started it, when there is one; a stale `CLAUDE_PID` with no session file no longer counts as the starting session). Both are cleared from what a subsession inherits, like the other session variables. A mod in the subsession can tell it is one, and whose: assumptions-pane 0.6.0 shows the subsession's assumptions in the starting session's pane, in any folder.

## 0.2.1 (2026-11-19)

- The status band shows only the subsessions this session started. Before, every Claude window on the computer showed every subsession. `claude-sub start` records the starting session (tmux option `@parent`); a subsession started by an older version still shows everywhere.

## 0.2.0 (2026-11-19)

- Status band (a mod): one row per running subsession directly above the prompt, in the terminal and the desktop app. It shows the state (busy, idle, question, waiting for permission, done), the protocol step, the current action, the time on the task, the cost, the context used and the process memory. Nothing is drawn while no subsession runs.
- Protocol: the subsession now sends each `progress:` line right after that step, in its own tool call. Before, it could send all of them together at the end, so none arrived live.

## 0.1.0 (2026-11-19)

- First version: `claude-sub` (start, list, stop, show, screen) and the `subsession` skill.
