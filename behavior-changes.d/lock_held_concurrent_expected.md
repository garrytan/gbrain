---
kind: fix
---
When two agent sessions (for example Claude Code and Codex) are open on one PGLite brain, the second session's gbrain_status answer for lock_held now names the owning server's PID and start time, carries expected: true and says nothing needs fixing, instead of asking the user to close the other session. The close_owner and share_http options are unchanged, and a brain held by a shared HTTP server or another gbrain process keeps the old answer.
