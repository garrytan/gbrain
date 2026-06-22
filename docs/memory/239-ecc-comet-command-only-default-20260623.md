# 239-ecc-comet command-only global default - 2026-06-23

Project: `G:\codex-project\comet-ecc`

Decision:

- Global comet-ecc should behave like upstream Comet by default: command/skill invocation only, no global prompt/session hook.
- `install-global` now defaults to `--mode command-only`.
- `--mode hooks` remains an explicit opt-in for always-on global hook/plugin installation.

Machine state:

- Applied `python comet_ecc.py install-global --platform all-ide --profile safe`.
- `global-status` reports all 8 IDE surfaces installed, each with `mode=command-only` and `hook_installed=false`.
- Command/skill entrypoints remain installed; global comet-ecc hook/plugin/rule surfaces were removed.

Evidence:

- Commit: `101eb54 Default global install to command-only mode`.
- Tests: `tests\test_adapters.py` -> 64 passed; `tests\e2e_matrix.py` -> passed.
- `strict-review`, `security-scan`, `version-audit`, and CodeGraph sync passed.

Rule:

- Do not reintroduce comet-ecc global hooks unless the user explicitly asks for hook mode.
