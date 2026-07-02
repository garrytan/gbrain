# s69-mc-codex writer live test opt-in

Recorded: 2026-06-19 22:14 China time
Owner/prefix: `s69-mc-codex-`
Marker: `s69-mc-codex-live-test-opt-in-20260619`

## Durable result

1. Writer live MiniMax/MMX test no longer runs under default pytest just because an API key exists.
2. `services/writer/tests/test_write_gate_live.py` now requires `OCTOS_RUN_LIVE_TESTS=1` before checking the MMX key or reaching any live outline/episode write path.
3. Explicit live testing remains possible by setting `OCTOS_RUN_LIVE_TESTS=1`.

## Evidence

1. Project repo: `G:\codex-project\s69-mc-codex`
2. Project commit: `08c93f46 test(writer): gate live mmx test behind opt-in`
3. File: `services/writer/tests/test_write_gate_live.py`
4. Verification:
   - `python -m pytest services\writer\tests\test_write_gate_live.py -q` -> 1 skipped
   - `python -m py_compile services\writer\tests\test_write_gate_live.py`
   - `python -m pytest services\writer\tests -q` -> 213 passed / 2 skipped
   - `python -m pytest services\determ\tests -q` -> 54 passed
   - `python -m pytest services\review\tests -q` -> 9 passed
5. Subagent review: Peirce APPROVE, 0 findings.

## Operational impact

1. Default offline regression can now use full writer tests without accidentally spending MiniMax/MMX quota or being blocked by provider volatility.
2. Live 40 writing remains blocked until a real structured `OCTOS_BRIEF_FILE`, fresh quota proof, and route-pressure clear proof exist.
