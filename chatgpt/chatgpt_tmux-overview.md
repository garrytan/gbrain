---
title: "Tmux Overview"
type: note
created: 2026-05-30
updated: 2026-05-30
source: chatgpt-export
conversation_id: 6a1b51b4-73f4-83e8-a97d-98b63b9e9c51
message_count: 2
tags: [chatgpt, import, code]
---
# Tmux Overview

> Conversation ID: 6a1b51b4-73f4-83e8-a97d-98b63b9e9c51
> Created: 2026-05-30T21:08:05Z
> Updated: 2026-05-30T21:08:15Z
> Messages: 2

---

## User

tmux

---

## Assistant

entity["software","tmux","terminal multiplexer"] is a terminal multiplexer. It lets you run multiple terminal sessions inside one terminal window, split the screen into panes, keep long-running processes alive after disconnecting, and reconnect later. citeturn0search0turn0search14

For your workflow with Hermes, Claude Code, OpenCode, SSH servers, and remote agents, tmux is effectively mandatory.

### Core concepts

| Concept | What it is |
|----------|------------|
| Session | A workspace that stays alive |
| Window | Like a tab inside a session |
| Pane | Split terminal inside a window |
| Detach | Leave the session running |
| Attach | Reconnect later |

### Basic commands

```bash
# start new session
tmux

# named session
tmux new -s hermes

# list sessions
tmux ls

# attach
tmux attach -t hermes

# detach
Ctrl+b d

# kill session
tmux kill-session -t hermes
```

### Most useful shortcuts

Default prefix is:

```bash
Ctrl+b
```

Then:

```text
Ctrl+b c      new window
Ctrl+b n      next window
Ctrl+b p      previous window

Ctrl+b %      vertical split
Ctrl+b "      horizontal split

Ctrl+b arrow  move between panes

Ctrl+b d      detach
```

### Typical AI-agent layout

```text
┌─────────────────────┬─────────────────────┐
│ Hermes Orchestrator │ Claude Code         │
├─────────────────────┼─────────────────────┤
│ OpenCode            │ Logs / Monitoring   │
└─────────────────────┴─────────────────────┘
```

Example:

```bash
tmux new -s jovie
```

Pane 1:

```bash
hermes
```

Pane 2:

```bash
claude
```

Pane 3:

```bash
opencode
```

Pane 4:

```bash
tail -f logs/hermes.log
```

### Why AI builders use tmux

If your laptop closes, Wi-Fi dies, SSH disconnects, or Atlas crashes:

```bash
tmux attach -t jovie
```

Everything is still running exactly where you left it. This is especially valuable for:

- Claude Code sessions
- Hermes orchestrators
- Long coding jobs
- Build processes
- Remote GPU servers
- SSH into VPSes

A common stack now is:

```text
iTerm2 / Warp / Ghostty
    ↓
tmux
    ↓
Hermes
    ↓
Claude Code / OpenCode / OpenRouter models
```

That gives you persistent agent infrastructure without losing context every time a terminal closes. citeturn0search0turn0search4turn0search11
