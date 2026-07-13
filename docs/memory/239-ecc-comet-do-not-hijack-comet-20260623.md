# 239-ecc-comet do not hijack standard comet - 2026-06-23

Project: `G:\codex-project\comet-ecc`

Problem:

- Global comet-ecc `UserPromptSubmit` hook intercepted a standard Claude `/comet` prompt in `G:\claude-project\GenericAgent`.
- It created `.comet-ecc/state.json` with `phase=build`, `task.type=bugfix`, and transcript-derived change name.
- This was incorrect because `/comet` is upstream Comet, not comet-ecc.

Fix:

- `UserPromptSubmit` only routes when the prompt explicitly contains `$comet-ecc` or `/comet-ecc`, or an existing `.comet-ecc/state.json` is active.
- `Stop` stays idle when no comet-ecc state exists.
- Global managed blocks now explicitly say plain `/comet` belongs to standard Comet and must not be rerouted.
- Bad GenericAgent `.comet-ecc` state was moved to `C:\Users\datoo\.comet-ecc\misroute-backups\GenericAgent-20260622T192550Z`.

Evidence:

- Commit: `da9139d Prevent comet-ecc from hijacking comet prompts`.
- Tests: `tests\test_adapters.py` -> 63 passed; `tests\e2e_matrix.py` -> passed.
- GenericAgent plain `/comet` probe returned idle and did not recreate `.comet-ecc/state.json`.
- `global-status`, `strict-review`, `security-scan`, `version-audit`, and CodeGraph sync passed.

Rule:

- Future global comet-ecc hooks must be opt-in for routing and must never create or rewrite comet-ecc state for upstream Comet `/comet`.
