# 239-codex-new-comet-ecc-default-glm-advisor-20260620

Recorded: 2026-06-20 17:25 China time.

Codex-owned durable note.

`G:\codex-project\comet-ecc` now applies default GLM-5.2 thinking advisor directives to selected ECC agents.

- Default directive shape: `<selected-agent>=glm-5.2:think:fallback-self`
- Explicit `--agent-llm` overrides the default for that agent.
- `--agent-llm-default off` disables defaults.
- Safe route/auto/invocation-safety still do not execute the external LLM call; they emit advisor commands and keep `external_llm_call` blocked.

Evidence:
- comet-ecc commit: `689da00 feat: default selected agents to glm advisor`
- Original user test task without explicit advisor now defaults `architect`, `code-architect`, and `planner` to GLM-5.2 think.
- `python -m pytest tests\test_adapters.py` -> 57 passed.
- `python scripts\comet_verify.py` -> ok true, audit passed=33 failed=0.
