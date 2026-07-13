# 239-codex-new comet-ecc lifecycle hooks - 2026-06-22

- Project: `G:\codex-project\comet-ecc`
- Commits: `4c759a6 feat: add comet-style lifecycle hooks`, `6b2a6b2 test: record lifecycle hook audit evidence`
- `comet-ecc` hooks now implement Comet-style lifecycle effects for hook-capable adapters:
  - `UserPromptSubmit`: apply lifecycle routing, state, phase artifact, platform/profile/ECC selection, session context injection.
  - `PreToolUse`: safe command guard.
  - `Stop`: decision/guard check and safe phase advancement.
- Hook execution writes `.comet-ecc/state.json`, `.comet-ecc/<phase>.md`, and `.comet-ecc/hook-events.jsonl`; it does not rewrite hook config on every prompt and does not spawn external workers or mutate real profiles by default.
- Evidence passed: py_compile, 60 pytest adapter tests, E2E matrix including prompt/stop lifecycle advancement, version audit, CodeGraph sync, and final clean audit with committed evidence (`claim_allowed=true`, `passed=13`, `failed=0`).
- Note for future audits: `audit --run-evidence --require-clean` can self-dirty by generating `.comet-ecc/evidence/`; commit or pre-generate evidence, then run `audit --evidence-file ... --require-clean`.
