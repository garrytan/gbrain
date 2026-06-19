# 239-codex-new AGENTS scope cleanup

Recorded: 2026-06-20 China time
Owner/prefix: `239-codex-new-`

## Durable rule

Global `C:\Users\datoo\.codex\AGENTS.md` should contain only cross-project behavior. Project paths, branches, corpus paths, provider matrices, run ids, dated phase decisions, and lane-specific rules belong in project `AGENTS.md`, daily logs, todo files, or project memory files.

## Cleanup performed

1. Replaced global `AGENTS.md` with an 86-line cross-project rule file.
2. Removed detailed Super69, Local3090, remem, and comet-ecc project rules from global active instructions.
3. Added project-local `AGENTS.md` for `G:\codex-project\remem`.
4. Added project-local `AGENTS.md` for `G:\codex-project\comet-ecc`.
5. Appended migrated rule indexes to existing dirty project files:
   - `G:\workbuddy-project\s69-codex\AGENTS.md`
   - `G:\codex-project\octos-长篇小说\octos\AGENTS.md`

## Evidence

1. `G:\codex-project\remem` commit `42d1206 docs: add remem project agent rules`.
2. `G:\codex-project\comet-ecc` commit `36fb31b docs: add comet-ecc project agent rules`.
3. `s69-codex` and `octos` project `AGENTS.md` files were already dirty; Codex did not commit them to avoid sweeping unrelated user/runtime changes.
