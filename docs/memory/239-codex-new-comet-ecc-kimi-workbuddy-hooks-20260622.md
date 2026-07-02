# 239-codex-new comet-ecc Kimi and WorkBuddy hooks

Recorded: 2026-06-22 02:57 +0800 by Codex.

`G:\codex-project\comet-ecc` commit `fd4fcf436730d28a9c746d9f8a8088e7d8357791` upgrades adapter handling:

- Kimi Code is no longer just pending/fallback in comet-ecc. Project install writes `.kimi/config.toml` managed `[[hooks]]` with `PreToolUse` and `Shell`, plus `.kimi` and `.kimi-code` skills.
- WorkBuddy is no longer doctor-only in comet-ecc. Project install writes `.workbuddy/settings.local.json` using the Claude-compatible hook shape.
- Real/production profile proof is supported for `codex`, `claude`, `codebuddy`, `kimi-code`, and `workbuddy`, still gated by explicit apply flags and default restore.
- MiniMax Code remains OpenCode-backed skill fallback unless stable public MiniMax Code hook schema appears. ZCode remains project skill fallback until marketplace package schema is implemented.
- Final verification passed: `python scripts\comet_verify.py` returned ok with `py_compile`, `pytest`, `e2e_matrix`, `version_audit`, and `production_clean_audit`; audit summary `passed=38`, `failed=0`.
