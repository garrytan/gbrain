---
kind: add
---
With skill loading on for Claude Code or Codex, the SessionStart hook now prints the skills pinned for that harness (gbrain skills pin add <id> --catalog claude-code-user or codex-user) and the text of the new setting skills.resolver.per_harness.<claude-code|codex>.session_start, on startup, resume, clear and after compaction. With no pins and no text the hook prints nothing, as before. An install whose hook doctor shows as outdated needs gbrain setup <harness> --skill-loading resolve once.
