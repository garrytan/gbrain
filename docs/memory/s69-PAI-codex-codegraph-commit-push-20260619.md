# s69-PAI-codex CodeGraph commit push rule

Recorded: 2026-06-19 22:20:09 +08:00
Owner/prefix: `s69-PAI-codex-`

User rule:

1. For larger code changes in this worktree, inspect CodeGraph first.
2. Small, clearly scoped edits do not require CodeGraph upfront.
3. After project updates, make a scoped commit, push the `s69-PAI-codex` branch, and update the local CodeGraph with `codegraph sync`.
4. Keep this as a project/worktree rule, not a global `AGENTS.md` rule.
