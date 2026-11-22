**Claude Code and Codex now show your pinned skills, and a note you write, at the start of every session and again after it compacts.**

<!-- behavior-change: skill_resolver_session_start_block -->

### Added
- With skill loading on (`gbrain setup claude-code --skill-loading resolve`, or `codex`), the SessionStart hook now prints the skills you pinned for that harness (`gbrain skills pin add <id> --catalog claude-code-user`, or `codex-user`) and the text in a new setting, `skills.resolver.per_harness.<claude-code|codex>.session_start`, on startup, resume, clear and after compaction, so neither is lost when the conversation is compacted. Pins use the same rules and 600-token cap as OpenClaw, Pi, Hermes and Cursor: a pin whose skill is gone is left out, and Codex lines carry each SKILL.md path. The note is plain text of at most 600 tokens, set with `gbrain config set skills.resolver.per_harness.claude-code.session_start "<text>"`; a bad value is refused with `skill_resolver_config_invalid`. With neither set the hook prints nothing, as before.
- A skill pinned for Claude Code or Codex is no longer also suggested on a turn.
- `gbrain skills pin add|remove|list --catalog claude-code-user` (or `codex-user`) now says the pins reach that harness at its next session start.
- Everything lives in `~/.gbrain/config.json`, so it works with no brain and no brain repository. Existing installs need no setup run: the SessionStart entry setup already wrote fires on every source.
