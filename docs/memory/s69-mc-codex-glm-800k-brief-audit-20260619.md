# s69-mc-codex GLM 800K Review And Brief Source Audit

Recorded: 2026-06-19 20:48:00 +08:00
Owner/prefix: `s69-mc-codex-`

## Memory

- GLM review in this Codex lane is direct 800K big-window review.
- Active review panel: MiniMax-M3-think, GLM-5.2-thinking 800K big-window, GPT-5.5 synth. No Claude reviewer.
- Production route checked by CodeGraph:
  `post_generation_review.run_post_generation_review()` -> `octos_determ.review_drama_file()` -> `review_dispatch.review(... format="drama")` -> `drama_review_panel.run_drama_panel()`.
- `review_dispatch.py` uses `_BIG_TOK = 800_000`; `drama_review_panel.run_drama_panel()` uses `RS._glm_judge_big(...)` for GLM.
- Offline selftests passed:
  - `python services\determ\_legacy\tools\qa\review_dispatch.py --selftest`
  - `python services\determ\_legacy\tools\qa\drama_review_panel.py --selftest`
- `《机关术之八门之乱》梗概和人物小传(1).docx` is only `candidate_source_partial`, not a direct production `OCTOS_BRIEF_FILE`, because it lacks explicit 40-episode arc and ending/card-hook plan.

## Evidence

- Project: `G:\codex-project\s69-mc-codex`
- Commit: `e29ead88 docs: record glm 800k review readiness`
- Evidence doc: `docs\qa\brief-source-candidate-jiguanshu-20260619.md`
- Daily log/todo: `619.md`, `619todo.md`
