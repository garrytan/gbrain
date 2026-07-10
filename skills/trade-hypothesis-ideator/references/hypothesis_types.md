# Hypothesis Types

## Mapping to entry_family
- `breakout` -> `pivot_breakout` (exportable)
- `earnings_drift` / `gap_continuation` -> `gap_up_continuation` (exportable)
- `momentum` / `pullback` / `regime_shift` -> `research_only` (not exportable in v1)

## Notes
- `edge-finder-candidate/v1` supports only `pivot_breakout` and `gap_up_continuation`.
- `gap_open_scored` is treated as research-only until v2 support is added.
