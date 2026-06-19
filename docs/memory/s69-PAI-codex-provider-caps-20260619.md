# s69-PAI-codex provider concurrency cap rule

Recorded: 2026-06-19 22:35 China time
Owner/prefix: `s69-PAI-codex-`
Marker: `s69-PAI-codex-provider-caps-20260619`

## Rule

1. Provider/runtime maximum active concurrency for this lane is `MMX=6`, `GLM=2`, and `Codex=2`.
2. Scheduling should fill available slots as much as possible when doing so does not weaken writing quality, review quality, quota checks, route-pressure gates, provider safety, or evidence isolation.
3. Future writer, repairer, reviewer, runner, and scheduler changes should use this cap instead of older conservative defaults such as `MMX=2`.
4. This is project/worktree-specific and should stay in project-local files and prefixed memory notes, not global `AGENTS.md`.
