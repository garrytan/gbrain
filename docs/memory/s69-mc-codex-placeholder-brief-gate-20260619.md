# s69-mc-codex placeholder brief gate

Recorded: 2026-06-19 20:30 China time
Owner/prefix: `s69-mc-codex-`
Source project: `G:\codex-project\s69-mc-codex`
Source commit: `d842d898 fix(writer): block placeholder production briefs`

## Durable rule

Formal 40/80 production briefs must not contain placeholder text. The gate blocks:

- `待补`
- `待定`
- `待完善`
- `后续补充`
- `稍后补充`
- `空缺`
- `占位`
- `TODO`
- `TBD`
- `此处略`
- `省略`
- `略写`
- `略过`
- `示例`
- `placeholder`

Bare `略` is intentionally allowed to avoid false positives in valid story words
such as `谋略`, `策略`, `战略`, `方略`, or `略显`.

## Verification

- Subagent review `Bohr`: `0 findings / APPROVE`
- Targeted tests: 82 passed
- Writer non-live: 173 passed / 13 deselected
- Determ tests: 47 passed
- Review tests: 9 passed
- py_compile passed
- No live provider launched
