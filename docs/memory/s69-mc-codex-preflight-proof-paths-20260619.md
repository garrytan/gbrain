# s69-mc-codex launch preflight proof paths

Recorded: 2026-06-19 20:39 China time
Owner/prefix: `s69-mc-codex-`
Project: `G:\codex-project\s69-mc-codex`
Commit: `658c3eaf fix(writer): align preflight proof paths`

Durable rule/result:
- Launch preflight and runner provider readiness must resolve provider proof paths the same way.
- `launch_preflight.build_launch_preflight()` now passes `env` into `provider_readiness.quota_proof_path()` and `route_pressure_path()`.
- `OCTOS_PROVIDER_QUOTA_PROOF_FILE` and `OCTOS_PROVIDER_ROUTE_PRESSURE_FILE` are honored by preflight, matching runner behavior.
- Explicit `quota_path` / `route_path` arguments still have priority over env overrides.

Verification:
- Targeted tests: launch_preflight/provider_readiness/run_config = 62 passed.
- Writer offline tests: 185 passed / 13 deselected.
- Determ tests: 47 passed.
- Review tests: 9 passed.
- `py_compile` passed for launch preflight and tests.
- Subagent review `Rawls`: 0 findings / APPROVE.
- No live provider writing or review was launched.
