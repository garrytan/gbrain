# Connect GBrain to opencode

> This page is the MCP-registration reference for **opencode** — the SST
> terminal coding agent (opencode.ai, npm `opencode-ai`; not OpenClaw, and not
> the original `opencode` CLI that was renamed Crush — see Troubleshooting).
> For the full brain install — CLI, engine, skills, dream cycle — follow
> [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md) first; this page wires
> the finished brain into opencode over stdio MCP. opencode is a
> **bootstrap-supported harness**: `gbrain bootstrap hooks --harness opencode`
> registers the brain for you (and `gbrain connect --agent opencode` handles
> remote brains — see below) — the commands on this page are the standalone
> manual recipe. Bootstrap's own registration additionally pins the workspace
> source (`GBRAIN_SOURCE`) and the full op surface, so the two are not
> byte-identical.

opencode spawns `gbrain serve` as a local stdio subprocess. No server, no
tunnel, no token needed. Works with both PGLite and Supabase engines — and
because opencode natively reads `AGENTS.md`, a gbrain workspace's rendered
brain contract loads with zero extra configuration.

## Register (recommended)

```bash
opencode mcp add gbrain --env GBRAIN_HOME=$HOME -- gbrain serve --surface verbs
```

`--surface verbs` exposes the seven-verb memory protocol (`recall`,
`remember`, `entity`, `synthesize`, `forget`, `context_pack`, `delta` —
[MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md)) instead of the full
100+-op catalog — the recommended starting surface for coding agents.
Three facts about `opencode mcp add`, all observed:

- **The local-command form is `-- <command> [args...]` after the flags** —
  it's real but missing from `--help` (which shows only `--url/--env/--header`).
  `--env` is repeatable, one `KEY=VALUE` per flag.
- **Registration is lazy.** The add writes config and exits 0 without
  connecting — even for a nonexistent command. Verify with `opencode mcp list`
  (below), never with the add's exit code.
- **It always writes the USER-GLOBAL config**
  (`~/.config/opencode/opencode.jsonc`) — there is no scope flag. For a
  project-scoped entry, write the project `opencode.json` directly (next
  section) — but read the sharing warning first.

## Direct config (equally supported)

Global (`~/.config/opencode/opencode.jsonc`) or project (`opencode.json` in
the repo root — opencode's lookup traverses up to the git root):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "gbrain": {
      "type": "local",
      "command": ["gbrain", "serve", "--surface", "verbs"],
      "environment": { "GBRAIN_HOME": "/home/alice-example" },
      "enabled": true
    }
  }
}
```

Comments are fine — opencode parses JSONC in both `.json` and `.jsonc` files,
and both filenames are read (merged) when both exist. To remove gbrain,
delete the entry, or set `"enabled": false` to disable without losing it.

**Sharing warning for project config:** opencode spawns project-defined local
MCP servers with **no trust prompt** — a committed `opencode.json` carrying a
gbrain entry executes on every collaborator's machine. Teammates without
gbrain get a failing spawn each session; teammates WITH gbrain attach their
own `host` brain to your repo's context. Prefer the user-global config (the
gbrain bootstrap default); if you do commit a project entry, use the
PATH-resolved `"gbrain"` command form (never an absolute path) and tell
collaborators `"enabled": false` is the opt-out.

## Verify

```bash
opencode mcp list        # the real probe: SPAWNS the server
```

`opencode mcp list` performs the actual spawn + handshake for every
configured server — expect `✓ gbrain connected`. A broken registration shows
`✗ gbrain failed` with the reason (e.g. `Executable not found in $PATH`).
Because it spawns everything — including any project `opencode.json` entries
in your cwd, with no trust prompt — run it from a directory you trust
(gbrain's own bootstrap verification probe runs from an empty temp directory
for exactly this reason, and skips the live probe entirely for project-scoped
registrations).
Two caveats: the exit code is 0 even when servers fail (read the output, not
`$?`), and `opencode mcp debug` is OAuth-only diagnostics — it is NOT a
handshake probe for local servers. Then one real round-trip:

```bash
opencode run "use the gbrain recall tool to answer: what did I import most recently?"
```

`opencode run` (headless one-shot) prints the final answer alone on stdout
(UI goes to stderr). MCP tools work in run mode without any permission flags.

## Remote brains (`gbrain connect`)

For a brain served over HTTP on another machine:

```bash
gbrain connect https://your-host/mcp --token gbrain_xxx --agent opencode [--install]
```

Without `--install` it prints the config block to add; with `--install` it
writes the entry directly into the user-global config (no opencode binary
required — the JSONC write IS the registration) and smoke-tests the token.
Either way the config stores only the `{env:GBRAIN_REMOTE_TOKEN}`
interpolation — opencode resolves the env var at read time, so the token
never lands in the file. Export `GBRAIN_REMOTE_TOKEN` in your shell profile.
`--force` replaces a gbrain-managed entry whose endpoint moved (a rotated
serve); an entry gbrain didn't write is never replaced — pick another
`--name`. (Framework-spawned opencode inherits no shell profile;
`gbrain bootstrap harness --harness opencode` covers that case with an
inline-bearer entry written 0600.)

## Auth + model pin

- **Keyless works.** opencode ships an anonymous free tier (default model
  `opencode/big-pickle` at observation time) — headless runs and MCP tool
  calls work with zero credentials. For paid providers, export the provider
  key (e.g. `ANTHROPIC_API_KEY`) or run `opencode auth login` (credentials
  land in `~/.local/share/opencode/auth.json`).
- **Model pin:** pass `-m <provider/model>` per call, or set `"model"` in the
  config. `opencode models` lists what your credentials can reach.
- **Updates:** opencode self-updates by default. For pinned/reproducible
  environments, set BOTH `"autoupdate": false` in config AND
  `OPENCODE_DISABLE_AUTOUPDATE=1` in the environment.

## Pair with cron

opencode has no built-in cron; schedule headless one-shots with your system
scheduler:

```bash
# crontab: brain maintenance every 4 hours
0 */4 * * * opencode run "Run gbrain sync and report anything unusual"
```

See [docs/guides/cron-schedule.md](../guides/cron-schedule.md) for the full
brain maintenance protocol (sync, embed, dream cycle).

## Troubleshooting

- **Wrong `opencode` on PATH** — the name has prior claimants (the original
  `opencode` project was renamed Crush). The SST CLI answers
  `opencode --version` with a bare semver (`1.18.18`) and has `opencode mcp`
  + `opencode debug paths` subcommands. Install it via
  `npm install -g opencode-ai` or `curl -fsSL https://opencode.ai/install | bash`.
- **opencode ≠ OpenClaw** — opencode (opencode.ai / SST) is the terminal
  agent this page covers; OpenClaw is the agent platform with its own gbrain
  runner and docs ([OPENCLAW.md](OPENCLAW.md)).
- **`✗ gbrain failed — Executable not found in $PATH`** — the registered
  command was the bare `"gbrain"` name and opencode's PATH doesn't carry it.
  Use the absolute binary path in the user-global config, or fix PATH.
- **Registered but nothing changed mid-session** — opencode reads config at
  session start; restart opencode (or start a new session) after registering.
- **`OPENCODE_CONFIG` seems ignored** — observed inert in v1.18.18: only
  `HOME`/`XDG_CONFIG_HOME` move the config location. Don't rely on it.
- **Which config won?** — `opencode debug config` prints the resolved merge;
  `opencode debug paths` prints every directory opencode uses.
- **Rules files** — opencode loads the project `AGENTS.md` (a sibling
  `CLAUDE.md` is NOT double-loaded; AGENTS.md wins). gbrain's rendered
  workspace contract rides this natively.

---

Verified against **opencode v1.18.18** (fast-moving project — the pin is
enforced in CI, with a latest-version canary leg watching for drift).
Dev-facing observed-behavior notes (exact flag semantics, exit-code caveats,
config schema, CI pin values) live in [OPENCODE-CLI-PIN.md](OPENCODE-CLI-PIN.md).
