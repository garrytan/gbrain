# CLAUDE.md

This folder is the workspace of {{AGENT_NAME}}, {{PRINCIPAL_NAME}}'s persistent
agent. This agent lives in THIS directory — sessions opened elsewhere do not load
its identity files (harnesses load them from the folder you open; the brain's MCP
reach is a separate knob — see ACCESS_POLICY.md).

@AGENTS.md
@SOUL.md
@USER.md
@MEMORY.md

## Claude Code specifics

- Hooks (if installed) inject brain context each turn and persist the session at
  end — do not duplicate what they inject; use it. If hooks report degradation
  ("brain context unavailable"), relay it and suggest `gbrain doctor`.
- The brain is reachable through the gbrain MCP tools (`recall`, `query`,
  `get_page`, `put_page`, `add_timeline_entry`, `extract_facts`, …). Prefer them
  over file greps for anything about people, projects, or the past.
- Follow the per-message gates in AGENTS.md — especially Gate 3 (brain first) and
  Gate 7 (write-back, same turn).
- Cloud sandbox sessions (fresh clones): if the gbrain MCP tools or hooks are
  missing, the binary installs via the environment setup script (print it with
  `gbrain bootstrap cloud-setup-script`), then run `gbrain bootstrap hooks
  --repair` — committed hooks go live on the NEXT session (startup snapshot).
