# s69-PAI-codex GLM review 800K big-window rule

Recorded: 2026-06-19 23:12 China time
Owner/prefix: `s69-PAI-codex-`

User correction: GLM review now uses a direct `800K` big-window path.

Project-specific operational rule:

1. In `G:\codex-project\s69-PAI-codex`, `format=drama` / 一卡 review keeps the panel on `GLM-5.2-thinking + MiniMax-M3-think` up to `800K` tokens.
2. The old `200K` small threshold must not cause PAI-codex drama review to switch to Claude mid-tier.
3. Inputs above `800K` tokens should be treated as over/cross-window-needed unless the user explicitly authorizes a different route.
4. This is a Codex-owned project memory note; do not rewrite Claude-owned memory files for this correction.

Evidence:

- Project log: `G:\codex-project\s69-PAI-codex\619.md`
- Project todo: `G:\codex-project\s69-PAI-codex\619todo.md`
- Code: `G:\codex-project\s69-PAI-codex\octos_pai\moat\review_dispatch.py`
- Tests: `G:\codex-project\s69-PAI-codex\tests\review\test_review_dispatch_drama.py`
