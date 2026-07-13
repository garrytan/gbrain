# s69-mc-codex formal stage quota proof gate

Recorded: 2026-06-19 20:18 China time
Owner/prefix: `s69-mc-codex-`
Project: `G:\codex-project\s69-mc-codex`
Commit: `f36c3379 fix(writer): require quota proof for formal stages`

Durable rule/result:
- Formal writing stages `40` and `80` must always require fresh provider quota proof.
- `OCTOS_PRODUCTION_EPISODE_THRESHOLD` must not downgrade formal `40` or `80` into smoke/no-quota mode.
- `provider_readiness._quota_proof_required()` now reuses `run_config._requires_production_brief()`.
- Low-episode smoke runs still skip quota proof, and non-formal episode counts still follow the configured threshold.
- GLM review rule remains direct 800K big-window in this lane; no Claude reviewer.

Verification:
- Targeted tests: `test_provider_readiness.py` + `test_run_config.py` + `test_launch_preflight.py` = 60 passed.
- Writer offline tests: 176 passed / 13 deselected.
- Determ tests: 47 passed.
- Review tests: 9 passed.
- `py_compile` passed for provider readiness, run config, launch preflight, and preflight CLI.
- Subagent review `Parfit`: 0 findings / APPROVE.
- No live provider writing or review was launched.
