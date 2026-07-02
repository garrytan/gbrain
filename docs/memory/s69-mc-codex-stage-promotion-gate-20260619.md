# s69-mc-codex 40->80 stage promotion gate

Recorded: 2026-06-19 19:45 China time
Owner/prefix: `s69-mc-codex-`
Source project: `G:\codex-project\s69-mc-codex`
Source commit: `385e10a6 fix(writer): gate 80 launch on 40 stage proof`

## Durable rule

The 80-episode stage may not start from plain run JSON, single-episode V11
grades, or shell-level claims. It requires an independent 40-episode promotion
manifest proving the previous stage reached V11 `S` or higher.

## Accepted proof

- `matrix_promotion_manifest.json`
- Sha256 coverage for:
  - `matrix_run.json`
  - `valid_generation_manifest`
  - `post_generation_review_manifest`
  - official Yika markdown/docx/package outputs
  - three required review files: MiniMax-M3-think, GLM-5.2-thinking, GPT-5.5 synth
- Exact episodes `1..40`, all ready, non-empty prose
- External brief/source hash binding
- Valid final gate, valid-generation manifest, post-generation review
- V11 `grade >= S`, `n_parsed > 0`
- No stop-clear evidence
- Official package `ok=true`, `md_ok=true`, `docx_ok=true`

## Implementation evidence

- New `services/writer/octos_writer/stage_promotion.py`
- `launch_preflight.py` and `run_config.py` enforce previous-stage proof for `episodes > 40`
- `OCTOS_PRODUCTION_EPISODE_THRESHOLD=80` does not bypass the gate
- `run_matrix.py` writes promotion manifest after 40 success and does not mutate `matrix_run.json` afterward
- Final subagent review `Sartre`: `0 findings / APPROVE`
- Tests: targeted 41 passed; writer non-live 167 passed / 13 deselected; determ 47 passed; review 9 passed; py_compile passed
