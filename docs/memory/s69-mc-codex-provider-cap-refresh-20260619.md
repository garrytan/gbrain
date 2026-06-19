# s69-mc-codex-provider-cap-refresh

Recorded: 2026-06-19 22:28:18 China time
Owner/prefix: `s69-mc-codex-`

## Source

- Project: `G:\codex-project\s69-mc-codex`
- Branch: `s69-mc-codex`
- Commit: `1c1bc0d2 fix(writer): refresh provider caps dynamically`

## Fact

The writer provider cap admission path now refreshes dynamic caps from `OCTOS_CAP_M3`, `OCTOS_CAP_GLM`, and `OCTOS_CAP_CODEX` during `write_one()` / `parallel_write()` admission.

Admission uses `_ACTIVE` plus `threading.Condition`:

- lowering cap does not kill active calls;
- new admissions respect the refreshed cap;
- `cap=0` pauses new admission with `provider <name> paused by cap=0`;
- invalid or negative cap values keep the previous cap to avoid fail-open capacity expansion.

## Verification

- `python -m pytest services\writer\tests\test_providers.py -q` -> 18 passed.
- `python -m pytest services\writer\tests -q` -> 216 passed, 2 skipped.
- `python -m pytest services\determ\tests -q` -> 54 passed.
- `python -m pytest services\review\tests -q` -> 9 passed.
- `python -m py_compile services\writer\octos_writer\providers.py services\writer\tests\test_providers.py` -> passed.
- Subagent `Singer` follow-up review -> 0 findings.
- `codegraph sync` -> already up to date.

## Boundary

This enables dynamic admission control only. It does not authorize live writing.
Formal 40-live remains blocked until a real structured `OCTOS_BRIEF_FILE`, fresh quota proof, and route-pressure clear proof exist.
GLM review remains direct 800K big-window review; Claude is not part of this lane's review panel.
