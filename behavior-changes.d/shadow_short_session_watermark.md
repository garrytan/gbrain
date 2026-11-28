---
kind: fix
---
Rust engine shadow mode: a brain used only through short serve sessions (for example MCP stdio sessions of 10 to 20 seconds) now reaches a valid coverage watermark and keeps it from one session to the next. A full reconcile pass is checked for 5 seconds after a serving process starts instead of a minute; a session that closes during a pass no longer records a failed pass, and the next session finishes it. A serving process that closes cleanly seals the follower, and the next session trusts the seal only once the database shows no other writer and no coverage gap since it; otherwise a full pass runs as before. Readiness still counts only finished clean full passes.
