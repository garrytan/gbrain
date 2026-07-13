# s69-mc-codex drama rating recheck

Recorded: 2026-06-19 21:30:00 +08:00
Owner/prefix: `s69-mc-codex-`

- Source repo: `G:\codex-project\s69-mc-codex`.
- Old todo for missing whole-script `age_rating` is closed by existing code.
- `octos_determ.review_script()` calls `drama_rating.scan(script_text)`.
- `services/determ/octos_determ/data/drama_rating.json` calibrates short-drama safety: ordinary violence is review-only; severe sexual/substance, child occult harm, and negative-value terms are hard.
- Verification: targeted rating/review_script/multi_version tests 8 passed / 39 deselected; full determ tests 54 passed.
- Project log commit pushed: `d50b2ddb docs: record drama rating recheck`.
