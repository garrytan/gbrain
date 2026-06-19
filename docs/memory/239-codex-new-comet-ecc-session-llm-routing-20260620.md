# 239-codex-new comet-ecc session LLM routing

Recorded: 2026-06-20 China time
Owner/prefix: `239-codex-new-`

Codex implemented current-session model/reasoning-aware routing in `G:\codex-project\comet-ecc`.

User requirement:

- `$comet-ecc` must pass the current session LLM model/version and thinking/reasoning level into routing.
- The selector must use that context to decide suitable ECC skills and agents.
- Test example: `我想开发一个比windows更屌的系统`.

Implementation:

- Commit `f989e92 feat: route using session llm context`.
- Added `SessionLLMContext`.
- Added CLI args `--session-model`, `--session-reasoning`.
- Added env fallback for `COMET_ECC_SESSION_MODEL`, `CODEX_MODEL`, `OPENAI_MODEL`, `COMET_ECC_SESSION_REASONING`, `CODEX_REASONING_EFFORT`, `OPENAI_REASONING_EFFORT`, `COMET_ECC_SESSION_THINKING`.
- Selector uses `session_llm_design_bias` to favor design/planning/agentic candidates for high-reasoning/frontier model contexts.

Proof:

- Route command with `--session-model GPT-5.5 --session-reasoning high` selected `agent-architecture-audit`, `architecture-decision-records`, `architect`, `code-architect`, `planner`, `agentic-engineering`, `agentic-os`, and `search-first`.
- Output showed `session_llm.model=GPT-5.5`, `session_llm.reasoning=high`, `frontier-model`, `high-reasoning`, and `session_llm_design_bias`.
- Safe dry-run kept `route.invocation.executed=false`.
- Evidence: `G:\codex-project\comet-ecc\docs\comet-ecc-session-llm-route-proof-20260620.md`.
- Clean verify: `python scripts\comet_verify.py` passed with `passed=33`, `failed=0`.

