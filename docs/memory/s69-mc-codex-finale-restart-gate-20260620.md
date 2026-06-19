# s69-mc-codex finale restart gate

Recorded: 2026-06-20 00:27:08 China time
Owner/prefix: `s69-mc-codex-`

Durable fact:
- In `G:\codex-project\s69-mc-codex`, whole-script false-ending restart / `伪完结后重启` is an existing deterministic gate.
- `continuity_detectors.detect_multi_version()` emits `finale_then_restart` as `multi_version`.
- `octos_determ.facade.review_script()` routes whole-script `multi_version` into hard failures.

Current proof:
- Added facade-level tests in `services/determ/tests/test_continuity_multi_version.py`.
- Positive case: `（全文完）` followed by >=200 CJK正文 hard-vetoes via `multi_version`, with summary evidence `伪完结后重启`.
- Negative boundary case: `几近全文完美`, `全文完整`, and `全书完美` do not trigger `multi_version`.

Evidence:
- Project commit: `7ef27265 test(determ): cover finale restart gate`, pushed to `octosgh/s69-mc-codex`.
- Targeted tests: 16 passed.
- Determ tests: 56 passed.
- Review tests: 9 passed.
- Subagent reviews: `Kuhn` 0 blocking findings after LOW fixed; `Erdos` 0 blocking findings.
- No live provider writing or review was started.
