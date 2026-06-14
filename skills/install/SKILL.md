---
name: install
description: Deprecated alias for setup when the user asks to install GBrain
triggers:
	- "install gbrain"
	- "gbrain install"
	- "install the brain"
tools:
	- get_stats
	- get_health
	- sync_brain
	- put_page
mutating: true
---

# Install GBrain (Deprecated)

This skill has been replaced by the **setup** skill. See `skills/setup/SKILL.md`.

The setup skill provides:
- Auto-provision Supabase via CLI (< 2 min TTHW)
- Manual fallback with non-interactive init
- AGENTS.md auto-injection (upgrade-safe)
- First import and health verification
