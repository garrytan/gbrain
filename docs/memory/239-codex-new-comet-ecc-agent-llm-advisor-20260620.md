# 239-codex-new-comet-ecc-agent-llm-advisor-20260620

Recorded: 2026-06-20 15:35 China time.

Codex-owned durable note.

`G:\codex-project\comet-ecc` now supports per-agent LLM advisory directives:

- `--agent-llm architect=glm-5.2:think:fallback-self`
- `--agent-llm planner=gpt-5.5:high`

Important boundary:
- Codex Desktop native subagent model override is still limited to Codex-supported models.
- GLM-5.2 is used as an external advisor inside the delegated task, not as the native subagent runtime.
- The delegated agent should call GLM-5.2 thinking first, use the result as advisory only, and fall back to itself if GLM fails.

Implementation evidence:
- comet-ecc commit: `0eeda64 feat: add agent llm advisor directives`.
- Added `AgentLLMDirective`.
- Added `--agent-llm` to `auto`, `route`, and `invocation-safety`.
- Added `scripts\glm_advisor.py`.
- Verified `python -m pytest tests\test_adapters.py` -> 55 passed.
- Verified `python scripts\comet_verify.py` -> ok true, audit passed=33 failed=0.
