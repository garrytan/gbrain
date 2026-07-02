# s69-mc-codex official yika subtitle consistency gate

Recorded: 2026-06-20 00:47:08 China time
Owner/prefix: `s69-mc-codex-`

Durable fact:
- In `G:\codex-project\s69-mc-codex`, official 一卡 strict detailed scripts require consistency between head `本集结尾卡点：...字幕：...` and final scene subtitle cue.
- Implementation: `services/writer/octos_writer/yika_format.py` extracts both subtitle texts, normalizes with `_norm_repeat()`, hard-fails mismatch as `final_subtitle_mismatch`, and hard-fails empty final subtitle as `final_subtitle_empty`.
- `allow_partial_last_script=True` exempts the last partial script from these strict checks.
- Official `《锦衣羽刃》一卡(1).docx` remains accepted; no literal `画面定格` requirement.

Evidence:
- Project commit: `26b0c855 fix(writer): validate yika subtitle consistency`, pushed.
- Targeted subtitle/reference tests: 6 passed.
- Writer tests: 252 passed, 2 skipped.
- Determ tests: 56 passed.
- Review tests: 9 passed.
- Subagent reviews: `Halley` 0 blocking with LOW; LOW closed; `Carver` final APPROVE.
- No live provider writing or review was started.
