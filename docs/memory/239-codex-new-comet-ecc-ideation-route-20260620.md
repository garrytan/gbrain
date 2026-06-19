# 239-codex-new comet-ecc ideation route fix

Recorded: 2026-06-20 China time
Owner/prefix: `239-codex-new-`

Codex fixed a `$comet-ecc` routing gap in `G:\codex-project\comet-ecc`.

User correction:

- Prompt like `$comet-ecc 我想开发一个比windows更屌的系统` should activate brainstorm/design/architecture and ECC agent candidates.
- It should not fall through to generic build/general routing.

Implementation:

- Commit `6789633 fix: route ideation tasks to design agents`.
- Chinese ideation/system phrases now classify as `design`.
- Design signals include `brainstorming` and `architecture`.
- Suggested packs include `brainstorming`, `architecture-audit`, `agentic-os`, `agentic-engineering`.
- ECC selector boosts `architect`, `planner`, `code-architect`, `agentic-os`, `agentic-engineering`, `agent-architecture-audit`, `architecture-decision-records`, and `search-first`.

Safety boundary:

- Safe dry-run selects ECC agents/skills as candidates but keeps execution blocked.
- No external agent subprocess is spawned unless an explicit execution path is used.

Verification:

- `python -m pytest tests\test_adapters.py` -> 51 passed.
- `python tests\e2e_matrix.py` passed.
- `python scripts\comet_verify.py` passed: `passed=33`, `failed=0`, `missing_for_claim=[]`.

