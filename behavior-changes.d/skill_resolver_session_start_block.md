---
kind: add
---
With skill loading on for Claude Code or Codex, the SessionStart hook now prints the skills pinned for that harness (gbrain skills pin add <id> --catalog claude-code-user or codex-user) and the text of the new setting skills.resolver.per_harness.<claude-code|codex>.session_start, on startup, resume, clear and after compaction. A skill pinned there is no longer also suggested on a turn. With no pins and no text the hook prints nothing, as before, and no setup run is needed.
