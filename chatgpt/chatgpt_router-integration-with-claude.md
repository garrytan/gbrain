---
conversation_id: 6a1b4801-4328-83e8-9209-46eb3b317760
created: 2026-05-30
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 3
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Router integration with Claude
type: note
updated: 2026-05-30
---

# Router integration with Claude

**Related:** [[coding_ai]]

> Conversation ID: 6a1b4801-4328-83e8-9209-46eb3b317760
> Created: 2026-05-30T20:26:42Z
> Updated: 2026-05-30T20:31:09Z
> Messages: 3

---

## User

can i use this with claude code but plug an open router rend pont into it

---

## Assistant

I’ll read “rend pont” as “endpoint” and verify Claude Code’s current provider/base-URL support against OpenRouter, separating official support from possible environment-variable routing.

---

## Assistant

Yes, Mr. White — **you can use Claude Code through OpenRouter**, and it *should* work best when OpenRouter is routing to **Anthropic first-party Claude models**.

The key caveat: **dynamic workflows are officially documented for Claude Code paid plans, Anthropic API, Bedrock, Vertex AI, and Microsoft Foundry**; OpenRouter is not listed as an official dynamic-workflows provider path. Claude Code via OpenRouter is supported by OpenRouter’s Anthropic-compatible layer, but OpenRouter says Claude Code is only guaranteed with the **Anthropic first-party provider**. citeturn790016view1 citeturn790016view0

## Setup

Add this to your shell profile, such as `~/.zshrc`:

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
export ANTHROPIC_API_KEY=""
```

OpenRouter specifically says to use `https://openrouter.ai/api`, pass your OpenRouter key as `ANTHROPIC_AUTH_TOKEN`, and blank out `ANTHROPIC_API_KEY` to prevent auth conflicts. citeturn790016view0

Then restart your terminal and run:

```bash
claude
```

Inside Claude Code:

```text
/logout
```

Then quit and relaunch Claude Code if you were previously logged into Anthropic directly. Verify with:

```text
/status
```

You should see:

```text
Auth token: ANTHROPIC_AUTH_TOKEN
Anthropic base URL: https://openrouter.ai/api
```

OpenRouter’s docs list that as the expected verification path. citeturn790016view0

## For dynamic workflows specifically

Use recent Claude Code:

```bash
claude --version
claude update
```

Dynamic workflows require **Claude Code v2.1.154 or later**, and on Pro they may need enabling in `/config`. citeturn790016view1

Then in Claude Code:

```text
/effort ultracode
```

or prompt it directly:

```text
Create a workflow to audit this repo for dead code and verify each finding before reporting it.
```

The docs say workflows can spawn dozens to hundreds of subagents, run resumably, and use `/workflows` to monitor them. citeturn790016view1

## Strong recommendation

For this setup, set the subagent model to a real Claude model through OpenRouter:

```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL="~anthropic/claude-opus-latest"
export ANTHROPIC_DEFAULT_SONNET_MODEL="~anthropic/claude-sonnet-latest"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="~anthropic/claude-haiku-latest"
export CLAUDE_CODE_SUBAGENT_MODEL="~anthropic/claude-opus-latest"
```

OpenRouter documents these Claude Code model override variables and warns that Claude Code is optimized for Anthropic models and may behave incorrectly with other providers. citeturn790016view0

## Practical answer

**Yes:** Claude Code → OpenRouter endpoint → Anthropic Claude model is viable.

**Risky:** Claude Code dynamic workflows → OpenRouter → non-Anthropic model. The workflow/subagent/tool-use behavior may break, degrade, or produce weird errors because Claude Code depends on Anthropic-compatible semantics.


**Topic:** [[chatgpt-clusters/coding_ai]]
