# s69-mc-codex source-bound checkpoints

Recorded: 2026-06-19 20:34 China time
Owner/prefix: `s69-mc-codex-`
Project: `G:\codex-project\s69-mc-codex`
Commit: `ce0503ee fix(writer): bind checkpoints to source brief`

Durable rule/result:
- Writer checkpoints for matrix/chunk resume must be source-bound to the current formal brief.
- Checkpoints now write `brief_sha256`, `brief_source`, and `checkpoint_binding`.
- `run_matrix.py` and `run_chunk.py` only resume checkpoints whose `brief_sha256` matches current `run_config.brief_sha256`.
- Missing current brief hash, missing checkpoint brief hash, mismatched hash, wrong episode count, or non-object checkpoint means no resume; the stale checkpoint is archived as `.stale-<utc>` and the runner starts fresh.
- This closes the historical partial fix where checkpoint resume preserved progress but did not prove the checkpoint belonged to the current `OCTOS_BRIEF_FILE`.

Verification:
- Targeted tests: checkpoint/matrix/chunk/launch_preflight = 47 passed.
- Writer offline tests: 183 passed / 13 deselected.
- Determ tests: 47 passed.
- Review tests: 9 passed.
- `py_compile` passed for checkpointing, matrix/chunk writer modules, runner CLIs, and tests.
- Subagent review `Gibbs`: initial HIGH fixed, final 0 findings / APPROVE.
- No live provider writing or review was launched.
