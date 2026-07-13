# 239-codex-new comet-ecc default GLM advisor verification addendum

Recorded: 2026-06-20 17:45 +0800
Project: G:\codex-project\comet-ecc

- Default selected-agent advisor behavior is implemented in commits `689da00` and `e19ad41`.
- With no explicit `--agent-llm`, comet-ecc defaults selected agents to `glm-5.2:think:fallback-self`.
- Live route proof for `我想开发一个比windows更屌的系统` defaulted `architect`, `code-architect`, and `planner`; directive source is `default`.
- Opt-out remains `--agent-llm-default off`.
- Final `python scripts\comet_verify.py` returned ok true; `py_compile`, `pytest`, `e2e_matrix`, `version_audit`, and `production_clean_audit` all returned 0.
- Final audit summary: passed 33, failed 0, failed_codes [].
- Version audit summary: ok true, v10_covered_by_v10 12, missing_for_claim [].
- comet-ecc branch `239-codex-new` was clean after final verification.
