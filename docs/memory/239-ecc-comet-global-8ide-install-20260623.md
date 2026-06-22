# 239-ecc-comet global 8 IDE install - 2026-06-23

Project: `G:\codex-project\comet-ecc`

Comet-ecc now supports global install/uninstall/status for the user's 8 IDE surfaces:

- Codex
- Claude
- Kimi Code
- OpenCode
- GLM ZCode
- MiniMax Code
- WorkBuddy/CodeBuddy
- Hermes Agent

Commands:

- `python G:\codex-project\comet-ecc\comet_ecc.py install-global --platform all-ide --profile safe`
- `python G:\codex-project\comet-ecc\comet_ecc.py uninstall-global --platform all-ide`
- `python G:\codex-project\comet-ecc\comet_ecc.py global-status`

Boundaries:

- WorkBuddy/CodeBuddy is counted as one user IDE surface.
- MiniMax Code is treated as OpenCode-backed through `.mavis` / `.mavis\.opencode`.
- Hermes internal DBs `kanban.db` and `state.db` are blocked mutation paths and must not be edited by comet-ecc global install.
- MiniMax internal app data remains blocked unless a future official schema is proven.

Evidence:

- Actual global install ran with `--platform all-ide --profile safe`.
- `global-status` returned `installed: true` for all 8.
- `pytest tests\test_adapters.py -q` returned `61 passed`.
- `tests\e2e_matrix.py`, `version-audit --version all --claim-level production`, `strict-review`, and `security-scan` passed.
- CodeGraph sync completed.

Backup:

- `C:\Users\datoo\.comet-ecc\global-install-backups\20260622T185548Z`
