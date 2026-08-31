# opencode CLI pin — observed behavior notes (v1.18.18)

Dev-facing companion to [OPENCODE.md](OPENCODE.md): every fact below was OBSERVED
against a real hermetic install (2026-08-15, macOS arm64), not researched from docs.
The claw-test OpencodeRunner, the install door e2e, and the heavy-tests
opencode-door CI job assert exactly these shapes — when opencode releases change
them, update this file, the workflow pins, and the affected assertions together
(`scripts/check-opencode-pin.sh` in `bun run verify` enforces the workflow-side
match). Where an observation CONTRADICTS opencode's docs, the observation wins and
the contradiction is called out inline.

Naming note: **opencode** (SST, opencode.ai, npm `opencode-ai`) is not **OpenClaw**
(the agent platform gbrain ships a runner for) and not the original `opencode` CLI
that was renamed Crush — see Troubleshooting in OPENCODE.md for the binary-name
collision.

<!-- opencode-pin: distribution_kind=npm -->
<!-- opencode-pin: npm_package=opencode-ai -->
<!-- opencode-pin: npm_version=1.18.18 -->
<!-- opencode-pin: npm_integrity=sha512-J+5HFq8tf+wPBBpBpMPSNjSytF2/EkNWYfFZh4si1d9auFbQriqDyqZv+vFUsLWERfdMU32Eajwuiq3rKBvZLQ== -->
<!-- opencode-pin: npm_linux_x64_integrity=sha512-WmeUnhljYJ252wywKTiW4bNDzsas2njpjPUEh0jM6HKNI4vFxJtREtzaWViY4AKEAcOkLWT8Ll17ixvcHz3AnA== -->
<!-- opencode-pin: npm_linux_arm64_integrity=sha512-e8D3g0qJEIzawEg2+ygW3vkZjAYL2ssyAx4GbihjwXwZFvlZZy5zRWWzdz5KLBoHSTl0FB73vNtnNeXONyHpVQ== -->
<!-- opencode-pin: opencode_version=1.18.18 -->
<!-- opencode-pin: observed_date=2026-08-15 -->

## Pin
- **opencode v1.18.18**, `opencode --version` output shape: bare `1.18.18` —
  version only, NO binary-name prefix, NO build hash (unlike grok's
  `grok 1.0.4 (hash)`). The door's T1 shape assert is `/^\d+\.\d+\.\d+$/` on the
  trimmed output; SST identity is discriminated by the `mcp`+`debug` subcommands
  existing (`opencode debug paths` exits 0 and prints the path table below —
  the renamed-to-Crush ancestor and other claimants have neither).
- **Provisioning (CI + local): pinned npm, pack-verify-install** —
  `opencode-ai@1.18.18`, registry integrity `sha512-J+5HFq…`. The CI job
  `npm pack`s the wrapper AND the runner's platform payload first (pack
  reports the integrity of the bytes it actually downloaded — closing the
  view-then-install TOCTOU), asserts both against the stamps above, then
  installs FROM the verified local wrapper tarball; the install-time platform
  sub-package fetch is validated by npm against the same packument integrity
  the pack step just byte-confirmed. The wrapper fans out to per-platform
  payloads (`opencode-{darwin,linux,windows}-{arm64,x64}[-baseline|-musl]`) as
  optionalDependencies at the same version; the LINUX payload integrities are
  pinned separately because the wrapper's integrity covers only the wrapper
  tarball. Darwin arm64 payload observed at
  `sha512-VkG+bz8u8Xqg9NzPK+2/71nEd4DKKlo2NLZurQ1eLAzDnmb1CMYZif/o6Shl8YFuTuYU/30k6yufl4Zr0Ij64g==`
  (informational — the CI runners are linux). Same npm version-immutability
  assumption as the grok pin, stated explicitly.
- A curl installer (`https://opencode.ai/install`) exists but is NOT the pinned
  lane; npm is.

## Pin-refresh cadence (this CLI ships near-continuously)
opencode releases far faster than grok (patch releases near-daily). The pinned
lane is the deterministic gate; the **canary leg** in `opencode-door` (schedule-
scoped, `continue-on-error`, installs `opencode-ai@latest`) exists to surface
drift BEFORE it strands the pin. Policy: when the canary leg reds or the pin is
>6 weeks old, run the re-observation checklist (bottom) against latest, bump the
stamps + workflow env pins together, and note behavior deltas in this file.
Do not chase every patch release; refresh on canary signal or the 6-week clock.

## Path seams — XDG honored; OPENCODE_CONFIG* env vars are INERT (verified)
`opencode debug paths` is the authoritative dump. Observed under
`HOME=<tmp> XDG_CONFIG_HOME=<tmp>/.config XDG_DATA_HOME=<tmp>/.local/share`:

```
config   <XDG_CONFIG_HOME>/opencode          (opencode.json + opencode.jsonc)
data     <XDG_DATA_HOME>/opencode            (auth.json, opencode.db*, log/, repos/)
state    <tmp>/.local/state/opencode         (locks/)
cache    <tmp>/.cache/opencode               (bin/)
tmp      /tmp/opencode
```

- **HOME + XDG_CONFIG_HOME/XDG_DATA_HOME redirection works fully on macOS**
  (nothing was written outside the hermetic home across the whole observation
  run). The door uses HOME + both XDG vars, belt-and-suspenders.
- **DOCS-CONTRADICTION: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and
  `OPENCODE_CONFIG_CONTENT` had NO observable effect on config resolution in
  1.18.18** — probes registered via each were absent from `mcp list`, while the
  XDG-resolved global config was still read. gbrain's path helpers therefore
  resolve via XDG only and deliberately do NOT honor `OPENCODE_CONFIG*`;
  re-observe on version bump (if a future release activates them, the helpers
  and this section change together). Hermetic child envs still DELETE all three
  (defense against a future release activating them).
- Volatile paths (tripwire exclusions): `opencode.db`, `opencode.db-shm`,
  `opencode.db-wal`, `log/`, `repos/` under data; `locks/` under state; `bin/`
  under cache. The tripwire hashes only `opencode.json(c)` + `auth.json`.
- Vendor quirk: opencode writes a `.gitignore` (node_modules, package.json, …)
  into the CONFIG dir on first touch.

## Config format — JSONC everywhere, both filenames merge (verified)
- `~/.config/opencode/opencode.jsonc` AND `~/.config/opencode/opencode.json`
  are BOTH read when both exist (servers from each appeared simultaneously in
  `mcp list`) — merge, not first-wins. opencode's own `mcp add` writes the
  `.jsonc` name.
- **Comments parse in `.json`-named files too** (a `// comment` inside project
  `opencode.json` did not break resolution). JSONC is the effective grammar for
  every config file regardless of extension → gbrain's writer treats all
  opencode configs as JSONC (jsonc-parser surgical edits; comments survive).
- Project config: `opencode.json` in the project root is read (lookup traverses
  up); a project-scope entry appears alongside global entries.
- Unknown keys inside an `mcp.<name>` entry are TOLERATED in 1.18.18 (an
  `_gbrain` probe key neither errored nor hid the server). gbrain still does
  NOT write marker keys — ownership is judged by structural fingerprint — so a
  future strict-schema flip cannot brick a user's opencode.
- `opencode debug config` prints the resolved merge (rendering has a doubled-
  line quirk; treat it as a debug view, not a parse surface).

## `opencode mcp add` — observed facts
- Shape: `opencode mcp add <name> [--env KEY=VALUE]... -- <command> [args...]`
  (local) or `opencode mcp add <name> --url <URL> [--header KEY=VALUE]...`
  (remote). The `-- command` form is real but UNDOCUMENTED in `--help` (the
  help lists only `--url/--env/--header`; the error copy for a bare add says
  `Provide either --url <url> or a command after --`).
- **Always writes the GLOBAL `opencode.jsonc`** — even when a project
  `opencode.json` with an `mcp` table exists in the cwd. There is NO scope
  flag. Project-scope registration requires writing the file directly (gbrain's
  writer does).
- **Add is lazy**: exit 0, no spawn, no prompt — for unreachable URLs and
  nonexistent commands alike. Never treat add's exit code as a handshake.
- **Rewrites preserve comments and foreign keys** (a seeded `// comment` and a
  `theme` key survived a subsequent add) — opencode uses a JSONC-preserving
  editor internally; gbrain's writer matches that bar.
- `--header` values are stored verbatim, including `{env:VAR}` interpolation
  syntax (`Authorization=Bearer {env:GBRAIN_REMOTE_TOKEN}` round-trips).

## Saved config schema (verbatim, from real adds)
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "gbrain": {
      "type": "local",
      "command": ["gbrain", "serve", "--surface", "verbs"],
      "environment": { "GBRAIN_SOURCE": "workspace", "GBRAIN_HOME": "/tmp/<brain-home>" }
    },
    "gbrain-remote": {
      "type": "remote",
      "url": "https://brain.example/mcp",
      "headers": { "Authorization": "Bearer {env:GBRAIN_REMOTE_TOKEN}" }
    }
  }
}
```
`enabled` is optional (absent = enabled). `oauth` was not written by the CLI and
is omitted by gbrain's writer (no OAuth interference with bearer headers was
observed). Local commands: an absolute `command[0]` works; PATH-resolved bare
`gbrain` resolves via the SPAWNING process's PATH (the door verifies the staged
bin-dir prepend).

## Probes — `mcp list` is the honest discriminator; `mcp debug` is NOT
- **`opencode mcp list` SPAWNS every configured local server and connects every
  remote one**, then prints per-server status: `✓ <name> connected` or
  `✗ <name> failed` with a reason line (`Executable not found in $PATH:
  "gbrain"`, `SSE error: …`). THE door's keyless handshake proof. Caveats:
  **exit code is 0 even when servers fail** (parse the text, assert
  `✓ gbrain connected`), output is clack-style UI with ANSI codes, and there is
  no `--json`.
- **`mcp list` is also a code-execution surface**: it spawned a PROJECT-defined
  `type:local` command from a fresh checkout with NO prompt and NO trust gate
  (verified with a touch-file probe). Two consequences: (1) gbrain's
  bootstrap default scope for opencode is USER-GLOBAL — a committed project
  entry would auto-spawn on every collaborator's machine; (2) any gbrain-run
  probe uses `--pure` (kills external plugin autoload) + `OPENCODE_DISABLE_AUTOUPDATE=1`.
- `opencode mcp debug <name>` is OAUTH debugging only — on a local server it
  prints `MCP server <name> is not a remote server` and exits 0. Not a
  discriminator.
- No tool-count line exists in `mcp list` (grok's `7 tools discovered` has no
  analog); tool discovery is proven by the SMOKE turn's `tool_use` events
  instead.

## One-shot (`opencode run`) — KEYLESS WORKS (anonymous free tier)
- `opencode run "<msg>"` prints the ANSWER TEXT ALONE on stdout; the session
  banner (`> build · <model>`) and UI go to stderr. Exit 0 on success; exit 1
  with a structured JSON error (`"ref": "err_…"`) on failure (e.g. bogus
  model).
- **Keyless runs WORK**: with zero credentials and no auth.json, `run` answers
  via opencode's anonymous free tier (default model observed:
  `opencode/big-pickle`; `opencode models` lists 8 keyless `opencode/*` models,
  most `-free` suffixed; `opencode stats` reports $0.00). There is no
  `Not signed in` wall in headless run mode.
- **MCP tools fire in keyless run mode WITHOUT `--auto`** (verified: the free
  model called `gbrain_recall` and returned a seeded per-run nonce with
  `--auto` absent). `--auto` exists (`auto-approve permissions that are not
  explicitly denied (dangerous!)`) but the door does not need or use it.
- MCP tool naming: `<server>_<tool>` (observed `gbrain_recall`).
- `--format json` emits NDJSON events, every event
  `{type, timestamp, sessionID, part}`; types observed: `step_start`,
  `tool_use`, `text`, `step_finish`. Tool events carry
  `part: {type:"tool", tool:"gbrain_recall", callID, state:{status:"completed",
  input:{…}, output:"<stringified JSON>"}}` — `parseOpencodeJsonl` pins this.
- Model flag: `-m/--model <provider/model>` (`opencode/big-pickle` confirmed;
  paid ids follow models.dev convention — see Pending auth).
- Keyless SMOKE end-to-end (proven 2026-08-15): pinned opencode + free model +
  real `gbrain serve --surface verbs` (7 verbs banner) recalled a per-run nonce
  through MCP with zero credentials, keyless PGLite brain.

## Environment — detectHarness + child-env facts (verified)
- Inside `run`'s bash tool, opencode sets **`OPENCODE=1`** and `OPENCODE_PID`
  in child processes → `gbrain bootstrap`'s `detectHarness()` probes
  `OPENCODE`.
- Auto-update kill: `OPENCODE_DISABLE_AUTOUPDATE=1` env + `"autoupdate": false`
  config — the door seeds BOTH; version stayed pinned across every observed
  run. `opencode upgrade` is the manual updater.
- Rules files: project `AGENTS.md` is loaded; a sibling `CLAUDE.md` is NOT
  double-loaded (nonce test: only the AGENTS.md nonce surfaced) — AGENTS.md
  wins per level, exactly as documented. gbrain's rendered pull-protocol
  contract works unchanged.
- `.well-known/opencode` remote config: never observed to fire in any CLI run
  (docs list it atop the lookup order). No kill needed today; re-observe on
  version bump.

## Auth (only needed for PAID providers)
- Anonymous free tier needs nothing on disk; `auth.json` is only created by
  `opencode auth login` at `<XDG_DATA_HOME>/opencode/auth.json`
  (`opencode providers`, alias `auth`, prints the path).
- The optional paid door leg gates on `ANTHROPIC_API_KEY` (env-only) and
  self-validates the model id against the authed `opencode models` output
  before spending. Missing-secret posture is SPLIT by trigger: on
  `pull_request` the paid leg is a VISIBLE SKIP (warning + job summary — the
  keyless tier's coverage, SMOKE included, is already banked, and neither a
  fork nor a branch PR author can fix repo secrets); the nightly schedule and
  `workflow_dispatch` stay loud-fail so the owner sees red until
  `gh secret set ANTHROPIC_API_KEY` runs.

## When the door goes red (triage)
| Failure class | Signature | Remediation |
|---|---|---|
| npm pin drift | install step: version/integrity mismatch | Re-pin deliberately: bump `npm_version`+`npm_integrity` (+ platform stamps), run the re-observation checklist, update workflow env pins (check-opencode-pin.sh enforces the pair) |
| canary leg red, pinned leg green | latest-version leg fails install/asserts | Upstream changed shape — schedule a pin refresh; pinned lane still gates |
| version drift mid-run | `opencode --version` re-check ≠ pinned | Auto-update engaged — verify BOTH kills (env + config seed); re-pin if deliberate |
| `✗ gbrain failed` in `mcp list` | `Executable not found in $PATH` / spawn error | Staged bin dir missing from PATH, or abs path wrong — registration bug, not opencode drift |
| free-tier drift | keyless SMOKE stops answering / new auth wall | Re-observe keyless posture; if the free tier is gated, flip the SMOKE to the ANTHROPIC leg and re-pin this section |
| paid leg: model id unknown | models-gate assert fails before any spend | Update the pinned anthropic model id from the authed `opencode models` output |
| paid leg skipped on a PR | `::warning` + "paid anthropic leg skipped" job summary; keyless tier green | Expected when the `ANTHROPIC_API_KEY` repo secret is empty — owner-only fix (`gh secret set ANTHROPIC_API_KEY`); the nightly stays loud-fail meanwhile |
| tripwire fired | manifest mismatch on `opencode.json(c)`/`auth.json` only | True isolation breach — stop and inspect; volatile-path drift alone must NOT fire |
| real door regression | handshake or nonce assert fails, pins intact | Bisect against the pinned version; file upstream if opencode-side |

Re-observation checklist on a version bump: npm pin captures (§Pin), help-surface
diff (`--help`, `run --help`, `mcp --help`, `mcp add --help`), the
add → saved-config → `mcp list` sequence (§add/§Probes), the keyless `run`
posture (§One-shot — free tier presence, stdout purity, MCP-without---auto),
`debug paths`, and the `OPENCODE_CONFIG*` inertness probe (§Path seams). The
spawn-gate probe (§Probes) re-runs whenever release notes mention MCP trust or
permissions.

## Pending auth (requires ANTHROPIC_API_KEY; the core door does NOT)
Authed `opencode models` list + exact `anthropic/<model>` id confirmation,
one paid one-shot smoke + per-turn cost note, `auth.json` verbatim shape after
`opencode auth login` (feeds evidence exclusions + TTY secretPaths), and
whether the authed TUI first-run differs from the keyless one pinned in the
dx scenario. The opencode-door paid leg self-validates the model id before
spending, so these pins harden the door but do not block it.

## Supported-version policy
gbrain's opencode integration is verified against **opencode v1.18.18** (this
pin). The canary CI leg tracks latest (continue-on-error); the pinned lane is
the deterministic gate. Keyless free-tier behavior is a LOAD-BEARING
observation (the SMOKE rides it) — treat free-tier changes as pin-refresh
triggers, not flakes.
