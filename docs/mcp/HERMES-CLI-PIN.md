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
- Installer sha256: `868ed3a91e0fabbff6d7418b3ede82bf4833652ec4e77196a42852fb35a9e5b9`
  (refreshed 2026-08-15: upstream installer drifted past the prior pin —
  reviewed; the `--commit` payload-pin path the door depends on is intact,
  and the payload pins (tag+commit) are unchanged)
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
  swallowed into the server argv. (First rehearsal failed exactly this way.)
  **The env flag takes MULTIPLE KEY=VALUE values after ONE flag; REPEATING it REPLACES the
  first occurrence** (argparse nargs semantics) — a repeated-flag invocation silently drops
  the earlier vars, the handshake fails, and the piped Y then hits the save-anyway prompt →
  the entry is saved with `enabled: false`. (First real door run failed exactly this way.)
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

## Cron (for the post-pin F7 TODO — real test is buildable)
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
- `HERMES_INSTALL_SHA256: "868ed3a91e0fabbff6d7418b3ede82bf4833652ec4e77196a42852fb35a9e5b9"`
- Door test asserts `hermes --version` output contains `v$HERMES_VERSION` when the env var is set.
- `hermes --version` output shape: `Hermes Agent v0.20.0 (2026.8.3)` + install dir + python lines.

## Multi-provider 401 gotcha (door hermeticity)
With `model.default` pinned to `anthropic/*` but a SECOND provider key visible (env or
.env — e.g. `OPENAI_API_KEY`), hermes's provider-auto mis-routes the request and the turn
returns `HTTP 401: Missing Authentication header` as final text with EXIT 0. The door
suite therefore seeds exactly ONE key (anthropic) and scrubs all provider env vars from
hermes children (`hermesChildEnv` in test/helpers/agent-harness.ts) — the seeded
`$HERMES_HOME/.env` is the single auth source.

## mcp add save-anyway (correction to an earlier note)
A piped `Y` saves the entry EVEN when the handshake failed — the save-anyway prompt
writes it with `enabled: false`. The success discriminators are `enabled: true` in the
saved YAML plus `hermes mcp test <name>` exit 0 — never the add's exit code, and not the
mere presence of the config entry.
