# Hermes CLI pin — observed behavior notes (v0.20.0)

Dev-facing companion to [HERMES.md](HERMES.md): every fact below was OBSERVED
against a real install (2026-08-12), not researched from docs. The claw-test
HermesRunner, the install door e2e, and the heavy-tests hermes-door CI job
assert exactly these shapes — when hermes releases change them, update this
file, the workflow pins, and the affected assertions together.

## Pin
- **Hermes Agent v0.20.0 (2026.8.3)**, observed against git checkout `3e09adb` at
  `~/.hermes/hermes-agent` (an upstream-main commit carrying the same v0.20.0/2026.8.3
  version stamp; CI installs the RELEASE TAG `v2026.8.3` = commit `3c27eb62` — the two
  differ by post-release main commits, same declared version. If a CI door run ever
  diverges from these notes, re-observe against the tag checkout.)
- Installer sha256: `2076946edc23b3aed4a82ccb2e6b38ab593575626206dbdd192384e375b6d57c`
  (observed 2026-08-31; the served `scripts/install.sh` matched byte-for-byte
  against the upstream repo at `a071fc80d`). Full-script review notes for
  this pin: the door flags (`--skip-setup`/`--non-interactive`/`--skip-browser`/
  `--skip-computer-use`/`--branch`/`--commit`/`--force-commit`) are intact
  and unknown flags hard-fail (`exit 1`, so a dropped flag can never silently
  skip the pin); outbound hosts are the expected toolchain (github,
  nousresearch, astral/uv, nodejs.org, pypi, npmmirror; plus a HEAD-only
  duckduckgo connectivity probe); no eval/base64 obfuscation; sudo limited to
  distro package installs (the one setuid chrome-sandbox sudo is
  desktop-build-only, never in the door path); the Node support gate is
  24.11+; the `run_locked_uv_sync` helper runs the Tier-0 `uv sync --locked`
  with PROJECT `[tool.uv]` config discovery enabled in a subshell while
  user/system uv config is redirected to an empty XDG dir, so the sync is
  hash-verified instead of falling through to the non-hash-verified PyPI
  tiers (the project config it discovers comes from OUR tag+commit-pinned
  checkout). KNOWN SURFACE, kept out of the door: the computer-use
  sub-installer pipes trycua/cua's installer from raw.githubusercontent.com
  at unpinned `main` to bash; the door passes `--skip-browser
  --skip-computer-use`, so no unpinned code runs in CI. Layout: non-root
  installs land at `~/.hermes/hermes-agent` (root installs use FHS
  `/usr/local/lib/hermes-agent`; the door's runners are non-root); npm-dep
  failures abort the install, absorbed by the door's 3-attempt retry;
  managed Node is v26.
  (download https://hermes-agent.nousresearch.com/install.sh to a file first; verify; then run)
- Installer flags used: `--skip-setup --non-interactive`; binary lands at `~/.local/bin/hermes`
- Python 3.11.15 via uv

## HERMES_HOME — HONORED (verified)
Installer (`HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"`) AND runtime both honor it:
`mcp add`/`mcp list`/`config set` under `HERMES_HOME=<tmp>` read+write `<tmp>/config.yaml`,
populate `<tmp>/{SOUL.md,cron,logs,...}`, and do NOT touch `~/.hermes`. Belt-and-suspenders
(HOME + HERMES_HOME both to tmp) stays in the door test anyway.

## One-shot (`-z`)
- `hermes -z "<prompt>"` → **stdout = final text ONLY**; benign notices may appear on stderr
  ("Shell cwd was reset to ..."). Verified reply fidelity ("B0-PROBE-OK").
- Exit codes: 0 = success; **1 = no inference provider configured** (message: "agent failed:
  No inference provider configured. Run 'hermes model' ... or set an API key
  (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) in ~/.hermes/.env.")
- `--usage-file PATH` exists; per-call `-m MODEL --provider PROVIDER` exist; also
  `--in DIR`, `--ignore-user-config`, `--safe-mode`, `-t TOOLSETS`, `--skills`.

## Auth + model pin (non-interactive)
- `$HERMES_HOME/.env` with `ANTHROPIC_API_KEY=...` WORKS (verified end-to-end).
- Model pin: `hermes config set model.default anthropic/claude-haiku-4.5` → exit 0,
  writes `model.default` into config.yaml. `hermes config get model.default` reads it back.
  (`hermes model` is INTERACTIVE-only — never use it in tests/CI.)
- Valid model id format: `anthropic/claude-haiku-4.5` (hermes catalog naming, provider-prefixed).

## `hermes mcp add` — THE big observed facts
- Shape: `hermes mcp add <name> [--env K=V K2=V2 ...] [--connect-timeout N] --command CMD --args ...`
  **`--args` MUST be the last option** — anything after it (incl. a misplaced `--env`) is
  swallowed into the server argv.
  **The env flag takes MULTIPLE KEY=VALUE values after ONE flag; REPEATING it REPLACES the
  first occurrence** (argparse nargs semantics) — a repeated-flag invocation silently drops
  the earlier vars, the handshake fails, and the piped Y then hits the save-anyway prompt →
  the entry is saved with `enabled: false`.
- Add performs a REAL MCP handshake + tool discovery at add time. Against
  `--command bun --args run <abs>/src/cli.ts serve` with `--env GBRAIN_HOME=<tmp>`:
  connected, discovered **110 gbrain tools**.
- On success it prompts `Enable all N tools? [Y/n/select]:` — **non-interactive: pipe
  `printf 'Y\n'`**. Piping Y saves: `✓ Saved 'gbrain' to <HERMES_HOME>/config.yaml (110/110
  tools enabled)`. EOF on the prompt = `Cancelled.`, nothing saved.
- **EXIT CODE IS 0 EVEN ON CONNECTION FAILURE OR CANCEL.** Never assert on `mcp add`'s exit
  code. Hard assertions = (a) `config.yaml` contains `mcp_servers.<name>` after the add,
  (b) `hermes mcp test <name>` exits 0.

## Saved config schema (verbatim shape)
```yaml
_config_version: 34
mcp_servers:
  gbrain:
    command: bun
    args:
      - run
      - /abs/path/src/cli.ts
      - serve
    env:
      GBRAIN_HOME: /tmp/gb-xxxx
    connect_timeout: 60.0
    enabled: true
```
(The generated file also contains commented template blocks — security, fallback_model.)

## Probes
- `hermes mcp list` → table `Name / Transport / Tools / Status`, row shows `gbrain ... ✓ enabled`.
- `hermes mcp test gbrain` → exit 0 + prints the tool list. THE targeted probe for Test 1b.
- `hermes doctor` exists (global health; not a per-server assertion).

## Cron
`hermes cron create [--name NAME] [--deliver ...] [--repeat N] [--skill S] [--script PATH]
[--no-agent] [--workdir DIR] [--model M] [--provider P] <schedule> [prompt]` — fully
non-interactive. `hermes cron tick` = run due jobs once and exit. `hermes cron list` exists.

## CI pin values (heavy-tests.yml `hermes-door` job)
- `HERMES_VERSION: "0.20.0"`
- `HERMES_GIT_TAG: "v2026.8.3"` + `HERMES_GIT_COMMIT: "3c27eb6234bf91b8ceee9e9071591b31e9b148cb"` —
  the installer's `--branch`/`--commit` flags pin the cloned PAYLOAD (the sha256 below only
  pins the installer script; without the tag+commit the payload would be upstream main).
  The flags are asserted, not trusted: post-install the job runs
  `git -C ~/.hermes/hermes-agent rev-parse HEAD` and loud-fails on any mismatch, so an
  installer that silently ignores unknown flags (or a moved checkout layout) can never
  run unpinned upstream code on a runner that later holds secrets.
- `HERMES_INSTALL_SHA256: "2076946edc23b3aed4a82ccb2e6b38ab593575626206dbdd192384e375b6d57c"`
- Door test asserts `hermes --version` output contains `v$HERMES_VERSION` when the env var is set.
- `hermes --version` output shape: `Hermes Agent v0.20.0 (2026.8.3)` + install dir + python lines.
- Missing-secret posture is SPLIT by trigger: on `pull_request` the paid leg is
  a VISIBLE SKIP (warning + job summary; installer digest, payload, and version
  pins still verified — neither a fork nor a branch PR author can fix repo
  secrets, and a permanently-red door trains reviewers to ignore it). The
  nightly schedule and `workflow_dispatch` stay loud-fail so the owner sees red
  until `gh secret set ANTHROPIC_API_KEY` runs.

## Multi-provider 401 gotcha (door hermeticity)
With `model.default` pinned to `anthropic/*` but a SECOND provider key visible (env or
.env — e.g. `OPENAI_API_KEY`), hermes's provider-auto mis-routes the request and the turn
returns `HTTP 401: Missing Authentication header` as final text with EXIT 0. The door
suite therefore seeds exactly ONE key (anthropic) and scrubs all provider env vars from
hermes children (`hermesChildEnv` in test/helpers/agent-harness.ts) — the seeded
`$HERMES_HOME/.env` is the single auth source.

## mcp add save-anyway
A piped `Y` saves the entry EVEN when the handshake failed — the save-anyway prompt
writes it with `enabled: false`. The success discriminators are `enabled: true` in the
saved YAML plus `hermes mcp test <name>` exit 0 — never the add's exit code, and not the
mere presence of the config entry.
