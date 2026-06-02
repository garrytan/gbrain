---
conversation_id: 69920e3f-7aa0-832b-acf0-e0989fd7dc73
created: 2026-02-15
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Apple Shortcuts Claude Code
type: note
updated: 2026-02-15
---

# Apple Shortcuts Claude Code

**Related:** [[coding_ai]]

> Conversation ID: 69920e3f-7aa0-832b-acf0-e0989fd7dc73
> Created: 2026-02-15T18:20:01Z
> Updated: 2026-02-15T18:21:16Z
> Messages: 2

---

## User

Can you use the Apple Shortcuts app to create a shortcut to send a slash command to Claude code? It seems on the surface that I'm only able to access Claude, not Claude code. What about Codex from ChatGPT?

---

## Assistant

Mr. White — **yes, you can use Apple Shortcuts to send text to Claude or ChatGPT, but “Claude Code” / “Codex” are separate entry points from the regular chat intents.** That’s why you only see “Claude” on the surface.

## Claude: why you can’t hit “Claude Code” directly from Shortcuts (on iPhone)
On iOS, Anthropic exposes a Shortcuts/App Intent called **“Ask Claude”** that sends a prompt to the *Claude app chat experience* (using whatever model you have set as default in the Claude app). citeturn2view0  
**That intent does not target Claude Code.** Claude Code is its own product surface (CLI / web), with its own session + repo context.

### What *does* work (practical options)
1) **Shortcut → SSH → run Claude Code CLI on a Mac/Linux box**
- Claude Code has a CLI that supports non-interactive prompts, e.g. `claude -p "query"` and session continuation. citeturn1view0  
- In Shortcuts, use **“Run Script over SSH”** to a machine that has Claude Code installed + authenticated, then run something like:
  - `cd /path/to/repo && claude -p "run: <your instruction>"`

If your “slash command” is a Claude Code slash command, you can often just include it at the start of the prompt you pass to the CLI (assuming slash commands are enabled for that session; there’s even a flag to disable them, implying they’re normally available). citeturn1view0

2) **Shortcut → SSH → use Claude Code web session launcher**
Claude Code CLI includes a `--remote` option to create a web session on claude.ai from a task description. citeturn1view0  
You can trigger that remotely too, then open the resulting URL on your phone (this is usually a “handoff” style workflow).

**Net: on iPhone alone, you get “Ask Claude” (chat). To reach Claude Code, you need a bridge (SSH to the CLI, or a web/Slack integration).**  

## ChatGPT / Codex: can Shortcuts hit Codex?
### If you just want “send a prompt from Shortcuts”
The ChatGPT app supports Shortcuts actions like **“Ask ChatGPT”** (and others, depending on version). This is the cleanest “no infrastructure” route for one-off prompts. (OpenAI community + Apple ecosystem coverage references this behavior; it’s commonly available in the official app UI.) citeturn5search13turn5search2

### If you specifically mean the **Codex coding agent**
Codex is also a distinct surface:
- **Codex CLI** (`codex ...`) runs in a terminal and can operate on a repo. citeturn4view2turn4view0  
- There’s also a **Codex macOS app** (announced Feb 2, 2026). citeturn3search9  

So the same pattern applies:
- **Shortcut → SSH → run `codex …` on a Mac/Linux machine** (best for “do coding work in my repo”)
- Or use the ChatGPT app’s Shortcuts action for “just ask” style prompts (best for lightweight Q&A)

## Quick rule of thumb
- **Shortcuts “Ask Claude”** = Claude chat only. citeturn2view0  
- **Claude Code / Codex** = needs CLI/web/IDE context → use **SSH from Shortcuts** to a machine running the agent, or use their dedicated apps/CLIs. citeturn1view0turn4view2turn3search9  

If you tell me what you’re trying to do with the slash command (e.g., “run tests”, “open PR review”, “apply formatting”, “generate a patch”), I’ll give you a concrete Shortcuts recipe (actions + the exact SSH command) for either Claude Code or Codex.


**Topic:** [[chatgpt-clusters/coding_ai]]
