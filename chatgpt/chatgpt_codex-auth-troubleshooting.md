---
title: "Codex auth troubleshooting"
type: note
created: 2026-04-27
updated: 2026-04-27
source: chatgpt-export
conversation_id: 69efd400-803c-83e8-a9be-982bff4a7031
message_count: 2
tags: [chatgpt, import, code]
---
# Codex auth troubleshooting

**Related:** [[coding_troubleshoot]]

> Conversation ID: 69efd400-803c-83e8-a9be-982bff4a7031
> Created: 2026-04-27T21:24:20Z
> Updated: 2026-04-27T21:24:43Z
> Messages: 2

---

## User

find the solution

---

## Assistant

Mr. White, likely fixes from this thread:

1. **Free port `1455`**
   - Check VS Code port forwarding / anything using port `1455`.
   - Stop it, then retry Codex auth.

2. **Rename your Codex config folder**
   - Safer than deleting:
   ```bash
   mv ~/.codex ~/.codex_original
   ```
   - Then restart VS Code / Codex and log in again.

3. **Re-auth through Codex CLI**
   ```bash
   codex
   /logout
   ```
   Then restart `codex` and sign in again.

Best order: **port 1455 → rename `~/.codex` → CLI logout/login**.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
