---
title: "Claude Code Hooks Setup"
type: note
created: 2026-02-15
updated: 2026-02-15
source: chatgpt-export
conversation_id: 69924ace-a49c-8326-a2c3-3741f9572b53
message_count: 2
tags: [chatgpt, import, code]
---
# Claude Code Hooks Setup

> Conversation ID: 69924ace-a49c-8326-a2c3-3741f9572b53
> Created: 2026-02-15T22:38:19Z
> Updated: 2026-02-15T22:38:46Z
> Messages: 2

---

## User

Is it possible to set up post to Claude code on mobile or desktop when it’s running in the cloud it’s automatically a command when it finishes

---

## Assistant

Yes, Mr. White — Claude Code has **hooks** that can automatically run a shell command when it finishes.

### The key hook events
- **`Stop`**: fires **when Claude finishes responding** (good “I’m done” trigger). citeturn2view1  
- **`TaskCompleted`**: fires when a task is being marked completed (useful if you rely on task boundaries). citeturn2view1  
- **`Notification`**: fires when Claude needs your attention / input. citeturn1view0  

### Easiest setup (desktop / remote VM)
Run **`/hooks`** inside the Claude Code CLI and add a hook for `Stop` (or `TaskCompleted`). The docs explicitly support storing hooks in `~/.claude/settings.json`. citeturn1view0turn1view1

### Example: run a command on completion (Stop hook)
Put something like this in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Claude finished' && date"
          }
        ]
      }
    ]
  }
}
```

Claude Code command hooks can run **any shell command**. citeturn1view1

### If it’s “running in the cloud” and you want it to reach your phone
Hooks run **where Claude Code is running** (your cloud box). So to notify mobile, have the hook call a push/webhook service, e.g.:

- `curl` an **ntfy** topic
- post to **Slack** incoming webhook
- call **Pushover**, etc.

Also, Claude Code sets an environment variable **`$CLAUDE_CODE_REMOTE="true"`** in remote web environments, which can help you branch behavior (local notify vs. webhook). citeturn1view1

If you tell me what you mean by “post to Claude” (Slack? Discord? an HTTP endpoint? something else) and what cloud you’re running on, I’ll give you a ready-to-paste hook command for that target.


**Topic:** [[chatgpt-clusters/coding_ai]]
