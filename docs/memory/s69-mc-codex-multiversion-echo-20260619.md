# s69-mc-codex multi_version echo handling

Recorded: 2026-06-19 21:24:10 +08:00
Owner/prefix: `s69-mc-codex-`

- Source repo: `G:\codex-project\s69-mc-codex`.
- Commit pushed: `3b469d0f fix(determ): tighten multi-version echo handling` on branch `s69-mc-codex`.
- `continuity_detectors.detect_multi_version()` now normalizes `本集结尾卡点`, `字幕`, and `△` heads before counting long duplicate prose segments.
- Echo exemption is segment-level and applies only when exactly two repeated long segments both originate from echo heads.
- Mixed echo/plain duplicate long prose, same-line ordinary long prose before a subtitle, ordinary duplicate long prose, and duplicate episode headings remain hard `multi_version`.
- Official 一卡 card/subtitle long-hook echo and repeated subtitle echo remain allowed.
- Verification: `test_continuity_multi_version.py` 7 passed; `services\determ\tests` 54 passed; writer yika/format targeted 44 passed.
- Review: `Epicurus` final `0 findings / APPROVE`.
- No live provider writing or review was launched.
