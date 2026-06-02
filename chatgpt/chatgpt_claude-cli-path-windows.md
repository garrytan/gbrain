---
title: "Claude CLI Path Windows"
type: note
created: 2026-01-08
updated: 2026-01-08
source: chatgpt-export
conversation_id: 69603465-1f38-8326-a280-69fd0e7c82b5
message_count: 2
tags: [chatgpt, import, code]
---
# Claude CLI Path Windows

> Conversation ID: 69603465-1f38-8326-a280-69fd0e7c82b5
> Created: 2026-01-08T22:49:19Z
> Updated: 2026-01-08T22:49:32Z
> Messages: 2

---

## User

Path to Claude code cli executable on widnows

---

## Assistant

On **Windows**, the **Claude Code CLI** executable path depends on how it was installed. In almost all cases it’s installed via **npm**, so the executable is a `.cmd` shim.

### Standard locations (npm)

**Per-user install (most common):**
```
%AppData%\npm\claude.cmd
```
Expanded:
```
C:\Users\<your-username>\AppData\Roaming\npm\claude.cmd
```

**System-wide install (if Node/npm was installed for all users):**
```
C:\Program Files\nodejs\claude.cmd
```

### Verify the exact path
Run this in **Command Prompt or PowerShell**:
```bat
where claude
```

That will print the full resolved path Windows is using.

### If `claude` is not found
1. Ensure it’s installed:
```bat
npm install -g @anthropic-ai/claude-code
```
2. Make sure this directory is on your `PATH`:
```
%AppData%\npm
```

### Direct executable (what actually runs)
The `.cmd` file points to:
```
%AppData%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.js
```

If you want, I can help you:
- Add it to PATH correctly
- Create a PowerShell alias
- Diagnose WSL vs native Windows conflicts
