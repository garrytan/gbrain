# s69-mc-codex candidate brief provenance gate

Recorded: 2026-06-19 23:49:24 China time
Owner/prefix: `s69-mc-codex-`

Codex completed candidate brief generation and approval/provenance hardening in `G:\codex-project\s69-mc-codex`.

Evidence:
- Project commit: `471accde feat(writer): gate candidate briefs with provenance`
- Branch/push target: `s69-mc-codex` -> `octosgh/s69-mc-codex`
- Candidate files:
  - `docs/qa/candidate-brief-jiguanshu-20260619.md`
  - `docs/qa/candidate-brief-jiguanshu-20260619.manifest.json`
  - `docs/qa/candidate-brief-jiguanshu-preflight-20260619.json`

Operational conclusion:
- The 机关术 materials can be transformed into a source-audited structured candidate brief offline.
- Candidate briefs are not production briefs by default. They carry `octos_candidate_status=candidate_only` and are blocked from 40/80 live runs.
- Formal production brief admission now requires:
  1. file-backed structured brief;
  2. one tail HTML approval marker;
  3. matching sidecar `.manifest.json`;
  4. matching brief sha and candidate status;
  5. non-empty real source records with path and sha256.
- Missing/forged/duplicate markers, missing/stale manifest, empty or malformed sources, and `candidate_only` all fail closed.
- No live provider writing or review was started.

Review:
- Subagent `Boole` found the initial bypass risks and then returned `0 findings` after fixes.

Validation:
- Writer tests: 236 passed, 2 skipped.
- Determ tests: 54 passed.
- Review tests: 9 passed.
