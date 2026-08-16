# Grok Build CLI pin — observed behavior notes (v1.0.4)

Dev-facing companion to [GROK.md](GROK.md): every fact below was OBSERVED against a
real install (2026-08-14), not researched from docs. The claw-test GrokRunner, the
install door e2e, and the heavy-tests grok-door CI job assert exactly these shapes —
when Grok Build releases change them, update this file, the workflow pins, and the
affected assertions together (`scripts/check-grok-pin.sh` in `bun run verify` enforces
the workflow-side match).

Naming note: **grok** (xAI Grok Build CLI, `XAI_API_KEY`) is not **groq** (Groq Inc.
inference, `src/core/ai/recipes/groq.ts`, `GROQ_API_KEY`) and not **ngrok** (tunnels).

<!-- grok-pin: distribution_kind=npm -->
<!-- grok-pin: npm_package=@xai-official/grok -->
<!-- grok-pin: npm_version=1.0.4 -->
<!-- grok-pin: npm_integrity=sha512-Nu3SFXTqwvCQr/LQFwrQYgngJhUQwX2h9ZSgzW4HowidjbPBWtMVO0xI88d2z6/zlDSNaT5YP/uk+2DthKQMsg== -->
<!-- grok-pin: npm_linux_x64_integrity=sha512-Dan2LfKcFBiabuDGHaGgMT8Ndzibo2ljvSjh4MlpV5117JL+S/0KMbdyYpk+13d7t+4znniW1cm+rRwUGSAvtw== -->
<!-- grok-pin: npm_linux_arm64_integrity=sha512-zGK42Eq3ZmIa7cSVnl6CiJ4cxTCMsNLQCmCoLJhy5eZXfAvZ1DA3K3HXmKCj4OScX8SalYlp7mx8HWl9Y6gytw== -->
<!-- grok-pin: grok_version=1.0.4 -->
<!-- grok-pin: installer_sha256=43d0943123edade1383a476a4f778674877acee7c1f98a00f094c4a0f7349321 -->
<!-- grok-pin: observed_date=2026-08-14 -->

## Pin
- **Grok Build v1.0.4**, `grok --version` output shape: `grok 1.0.4 (d846eb93d94d)`
  (version + build hash; the door's shape assert is `/^grok \d+\.\d+\.\d+ \([0-9a-f]+\)$/`).
- **Provisioning (CI + local): pinned npm install** — `@xai-official/grok@1.0.4`,
  registry integrity `sha512-Nu3SFX…`. The package fans out to
  `@xai-official/grok-{darwin,linux,win32}-{arm64,x64}` optional deps at the same
  version; the CI job pins the LINUX payload integrities too (stamps above) because
  the wrapper's integrity covers only the wrapper tarball — the platform sub-package
  is the binary that executes. Load-bearing assumption, stated explicitly: npm
  version-immutability (a published version cannot be replaced on npmjs; only a new
  version or an unpublish, both of which fail the pinned install loudly).
- Installer path (fallback only): `https://x.ai/cli/install.sh`, sha256
  `43d0943123edade1383a476a4f778674877acee7c1f98a00f094c4a0f7349321` (17,686 bytes).
  It SUPPORTS version pinning (`bash -s <X.Y.Z>`) and downloads versioned artifacts
  `grok-<version>-<os>-<arch>` from `https://x.ai/cli` (fallback GCS bucket
  `grok-build-public-artifacts`), self-checks `--version` post-download. Platform
  string from `uname -s`/`uname -m` with a Rosetta correction on Apple Silicon.
- Verified against macOS arm64; npm `os`/`cpu` matrix covers linux x64/arm64 for CI.

## GROK_HOME — HONORED (verified)
`GROK_HOME=<tmp> HOME=<tmp> grok mcp list|add|doctor` read+write `<tmp>/config.toml`
and do NOT touch `~/.grok`. Belt-and-suspenders (HOME + GROK_HOME both to tmp) stays
in the door anyway. NOTE what grok writes into `$GROK_HOME` on EVERY run (tripwire
exclusions — these are VOLATILE): `active_sessions.lock`, `active_sessions.json`,
`bin/grok-<version>` (it copies its own binary in), `logs/unified.jsonl`,
`docs/user-guide/*.md` (it ships its user guide into the home), `leader.sock` (a
leader daemon socket; `--leader-socket <PATH>` overrides). The tripwire hashes ONLY
`config.toml` + credential-class files, never the volatile set.

## One-shot (`-p`)
- `grok -p "<prompt>"` (`-p, --single`) prints the response to stdout and exits.
- `--output-format plain|json|streaming-json|streaming-messages-json` (default plain;
  `streaming-json` = NDJSON of native ACP session updates; `streaming-messages-json` =
  Anthropic Messages wire format; `--include-partial-messages` adds deltas).
- **Keyless one-shot: exit 1**, message (verbatim, both stdout and stderr):
  `Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.`
  → `hasGrokAuth()` = non-empty `XAI_API_KEY`; the TTY scenario's keyless early-stop
  matcher is `Not signed in`.
- Cost/toolset flags that EXIST (observed in --help): `--always-approve`,
  `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`,
  `--tools <LIST>`, `--disallowed-tools <LIST>`, `--allow/--deny <RULE>`,
  `--disable-web-search` (dedicated kill for web search + fetch — the door SMOKE uses
  THIS, not a tools list), `--max-turns <N>`, `-m/--model`, `--reasoning-effort`
  (alias `--effort`), `--cwd <PATH>`, `--rules`, `--prompt-file`, `--prompt-json`,
  `--json-schema` (implies json output), `--verbatim`, `--sandbox <PROFILE>`
  (env `GROK_SANDBOX`), `--no-memory`, `--no-plan`, `--no-subagents`.
- There is NO auto-update CLI flag. Auto-update is config: `[cli] auto_update = true`
  is the DEFAULT — hermetic homes MUST seed `[cli] auto_update = false`. Manual
  updater: `grok update [--check --json --version <V> --force-reinstall --alpha]`.
- `.envrc` gotcha: `load_envrc = true` by default — grok loads `.envrc` from the
  working directory. Door/live spawns pin `cwd` to tmp workspaces partly for this.

## Auth + model pin (non-interactive)
- Keyless error pinned above; `grok login --device-code` exists for headless
  interactive auth; `XAI_API_KEY` env is the documented headless path (its end-to-end
  smoke is **pending auth** — no key was available at observation time; the door's
  paid tier stays skip-gated until then, per plan D0).
- `grok models` works KEYLESS (exit 0): prints `You are not authenticated.`, then
  `Default model: grok-4.6` and the visible list (`grok-4.6 (default)`, `grok-4.5`).
  Authenticated list may be larger; per-turn cost pins are **pending auth**.
- Model pin mechanism: per-call `-m <model>` (authoritative in tests — immune to
  config rewrites) and `[models] default = "<model>"` in config.toml.

## `grok mcp add` — THE big observed facts
- Shape: `grok mcp add <name> [-e KEY=value]... [-s user|project] [-t stdio|http|sse] -- <command> [args...]`
  — everything after `--` is the server argv. **`-e/--env` is REPEATABLE, one
  KEY=value per flag** (their docs pin this as a breaking change from earlier
  releases: `use -e A=1 -e B=2, not --env A=1 B=2` — the hermes replace-bug class is
  fixed upstream). Server names: letters, numbers, hyphens, underscores only.
- **Add is LAZY: exit 0 always, NO handshake at add time, no interactive prompt**
  (`Added stdio MCP server 'gbrain' … to user config` / `File modified:
  $GROK_HOME/config.toml`). Adding a NONEXISTENT command also exits 0. Never assert
  add's exit code; never treat `enabled = true` in the saved TOML as a handshake
  proof (it is written unconditionally).
- Scope: `-s user` (default) → `~/.grok/config.toml`; `-s project` →
  `./.grok/config.toml` (committable; reference secrets as `${VAR}`).
- **Bare command names resolve via the CALLER'S PATH** (verified): registering
  `-- gbrain serve --surface verbs` with a PATH-prefixed bin dir works — doctor
  resolved bare `gbrain` to the staged wrapper and completed the handshake. The
  bun-run wrapper shim (`#!/bin/sh\nexec bun run <abs>/src/cli.ts "$@"`) works as the
  staged binary (the fallback lane when a compiled binary is unavailable).
- Startup timeout: per-server `startup_timeout_sec` (default 30) or global env
  `GROK_MCP_STARTUP_TIMEOUT_SECS` (seconds) / `MCP_TIMEOUT` (ms, Claude-compatible).
  The bun-run wrapper cold-transpiles slowly — the door sets 60+.

## Saved config schema (verbatim, from a real add)
```toml
[mcp_servers.gbrain]
command = "/tmp/<staged-bin>/gbrain"
args = [
    "serve",
    "--surface",
    "verbs",
]
enabled = true

[mcp_servers.gbrain.env]
GBRAIN_SOURCE = "workspace"
GBRAIN_HOME = "/tmp/<brain-home>"
```
Full schema keys (from grok's own shipped user guide, `$GROK_HOME/docs/user-guide/`):
`command`, `args`, `env`, `enabled` (default true), `startup_timeout_sec` (default
30), `tool_timeout_sec` (default 6000), `tool_timeouts`.

## Probes — the HONEST discriminator exists
- **`grok mcp doctor <name> --json`**: SPAWNS the server for real. Good server →
  **exit 0** with checks `command found` / `server started` / `handshake OK`
  (`"detail": "protocol 2025-11-25"`) / **`7 tools discovered`** (the verbs surface's
  seven verbs, proven keyless end-to-end). Broken server (nonexistent command) →
  **exit 1**, check `command not found`, `passed: false`, plus a `hint`. THE door's
  hard discriminator; the T4 doctor pre-flight gates the paid loop (plan M6 resolves
  to the honest branch).
- Doctor `--json` also enumerates config **sources** with per-source status —
  `~/.grok/config.toml`, `~/.claude.json`, `.mcp.json` — and each server carries a
  `"source"` field (`"config"`, `".mcp.json"`, …): the T2b provenance assertion reads
  this directly.
- `grok mcp list --json` → exit 0, array of `{command, args, env, enabled, name,
  scope}`.
- `grok inspect` (keyless, exit 0) shows version, CWD, `Project trusted: yes/no`,
  instructions, permissions, skills, agents — the config-discovery audit surface.

## Vendor-config fallback — TRUST-GATED (verified)
A project `.mcp.json` in the cwd is SEEN by doctor (source `found`, server listed
with `source: ".mcp.json"`) but the server check reports **`folder untrusted`** and
`mcp list` shows nothing until the folder is trusted (first-run trust flow). So:
fresh tmp HOME + fresh cwd ⇒ vendor entries structurally cannot activate (door
provenance guarantee), and on an operator's machine the fallback only engages for
folders they already trusted — the live-lane warning (operator `~/.claude.json`
carrying `mcpServers.gbrain`) still applies for trusted folders.

## When the door goes red (triage)
| Failure class | Signature | Remediation |
|---|---|---|
| npm pin drift | install step: version/integrity mismatch | Re-pin deliberately: bump `npm_version`+`npm_integrity` stamps here, re-run the re-observation checklist below, update workflow env pins (check-grok-pin.sh enforces the pair) |
| installer digest drift (fallback path) | `sha256sum -c` fails on install.sh | Diff the new installer, re-pin `installer_sha256` after review |
| version drift mid-run | `grok --version` re-check ≠ pinned | Auto-update engaged — verify `[cli] auto_update = false` seeding; re-pin if a deliberate bump |
| blank XAI_API_KEY secret | named precondition/paid-sentinel failure | Admin adds/rotates the repo Actions secret (console.x.ai origin); keyless tier still ran |
| invalid/expired key | bad-key preflight fails (pin its message after first authed run) | Rotate the secret; no code change |
| tripwire fired | manifest mismatch on config/credential files only | True isolation breach — stop, inspect which file changed; volatile-path drift alone must NOT fire (bug in exclusions if it does) |
| real door regression | doctor checks or recall assert fail with pins intact | Bisect against the pinned version; file upstream if grok-side |

Re-observation checklist on a version bump: re-run the npm/installer pin captures
(§Pin), the help-surface diff (`--help`, `mcp --help`, `mcp add --help`), and the
mcp add → saved-TOML → doctor sequence (§add/§probes). The one-shot/auth/model
sections only need re-observation if their assertions start failing.

## Keyless TUI behavior (observed via the dx-explore PTY instrument)
Under a real PTY with no credentials, interactive `grok` plays a Braille-
pattern intro animation (U+2800-range glyphs) for a few seconds, then settles
(~6s) onto a SIGN-IN screen: "Approve in your browser to finish signing in"
plus a device code (and a ctrl+c hint). There is no unattended path past it.
Two hazards for PTY automation, both observed: the animation frames carry
zero word-like text (3+-letter runs) — a text-presence heuristic must count
letter runs, not enumerate glyphs; and pasting into the sign-in screen leaves
a persistent full-screen spinner redrawing at ~5 frames/sec, which starves
quiet-based settling and makes full-buffer ANSI stripping the hot loop
(strip bounded raw tails instead). Headless keyless is the clean
`Not signed in` error above. The `grok-install` dx scenario early-stops at
the sign-in copy (or a persistently textless screen) with the friction
recorded — that IS the keyless measurement.

## Supported-version policy
gbrain's grok integration is verified against **Grok Build v1.0.4** (this pin). The
canary CI leg (enabled with the secret) tracks latest and is continue-on-error; the
pinned lane is the deterministic gate. **Pending auth** (requires `XAI_API_KEY`):
paid one-shot smoke, authed model list + per-turn cost pins, credential-file
inventory after login (feeds evidence exclusions + TTY secretPaths), AUTHED
first-run TUI dialog copy (the keyless TUI + headless copies are pinned above).
