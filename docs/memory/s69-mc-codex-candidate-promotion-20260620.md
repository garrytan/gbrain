# s69-mc-codex candidate brief promotion split

Recorded: 2026-06-20 00:04:04 China time
Owner/prefix: `s69-mc-codex-`

Project: `G:\codex-project\s69-mc-codex`
Commit: `46ebd96e feat(writer): split candidate brief promotion`

Codex completed the candidate brief promotion split:

1. Candidate generation is now candidate-only.
2. Approved production briefs can only be created through the explicit promotion tool.
3. Promotion requires `approved_by`, candidate marker, manifest/provenance, and source hashes.
4. Promotion writes a separate approved file and manifest; it rejects in-place overwrite of the source candidate.
5. Full test chain now covers candidate -> promote -> run_config production_ready -> launch_preflight ready_to_launch.

Validation:

- Targeted candidate/promotion/run_config/launch_preflight: 71 passed.
- Writer tests: 241 passed, 2 skipped.
- Determ tests: 54 passed.
- Review tests: 9 passed.
- `Socrates` review: final 0 blocking findings.

Lane review rule:

- GLM review is direct 800K big-window.
- Current panel is MiniMax-M3-think, GLM-5.2-thinking 800K, GPT-5.5 synthesis.
- Claude review remains removed for this lane.

No real candidate promotion and no live provider writing/review were started.
