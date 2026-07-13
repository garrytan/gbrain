# s69-mc-codex official yika subtitle-card ending gate

Recorded: 2026-06-20 00:39:34 China time
Owner/prefix: `s69-mc-codex-`

Durable fact:
- Official 一卡 full detailed episode scripts require a final subtitle card cue.
- Current implementation in `services/writer/octos_writer/yika_format.py`: strict script block hard-fails with `final_freeze_missing` unless the final line starts with `△` and contains `字幕：`.
- The gate deliberately does not require literal `画面定格`; official `《锦衣羽刃》一卡(1).docx` uses `△ 字幕：...` endings.
- `allow_partial_last_script=True` skips this strict-body check for the last partial script.

Evidence:
- Project commit: `ceae4a05 fix(writer): require yika subtitle card ending`, pushed.
- Targeted official_yika/delivery/v11/runner tests: 66 passed.
- Writer tests: 249 passed, 2 skipped.
- Determ tests: 56 passed.
- Review tests: 9 passed.
- Subagent reviews: `Turing` 0 blocking findings; `Pasteur` APPROVE / 0 blocking findings.
- No live provider writing or review was started.
