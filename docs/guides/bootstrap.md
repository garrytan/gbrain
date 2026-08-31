# GBrain Bootstrap — your harness as your agent

`gbrain bootstrap` turns a Claude Code, Codex, or opencode session into a
persistent personal agent: identity files rendered from your own answers, a local PGLite brain,
per-turn context, session-triggered schedules, and a private GitHub repo as the
agent's durable, portable body. This guide is the full contract — what gets
installed, what runs when, what it can and cannot do, and how to undo all of it.

Normative design docs: [AGENT_BOOTSTRAP_DESIGN.md](../designs/AGENT_BOOTSTRAP_DESIGN.md)
(scope) and [AGENT_BOOTSTRAP_PLAN.md](../designs/AGENT_BOOTSTRAP_PLAN.md)
(implementation). The paste block lives in the README; the runbook your agent
follows is `BOOTSTRAP_FOR_AGENTS.md` at the repo root, fetched at the
`latest-stable` ref.

## What gets installed, exactly

| Piece | Where | Runs when |
|---|---|---|
| Identity files (SOUL/USER/MEMORY/AGENTS/CLAUDE/HEARTBEAT/ACCESS_POLICY/GITHUB) | your workspace folder | loaded at session start |
| `agent.json` manifest + `brain/`, `memory/`, `skills/`, `state/` | workspace | — |
| Local brain (PGLite) | `~/.gbrain/` (never in the repo) | while a session's MCP serve is open |
| MCP registration (`gbrain serve`) | Claude Code: project scope by default; Codex: user-global (no scope flag); opencode: user-global by default (project scope is an explicit opt-in — see the degradation matrix) | spawned by your harness per session |
| Hooks (Claude Code, ON by default) | local installs: `.claude/settings.local.json` (gitignored); cloud sandboxes: the COMMITTED `.claude/settings.json` (PATH-resolved, fail-open commands) | each prompt; fail-open; `--no-hooks` opts out at install, `GBRAIN_HOOKS=0` disables at runtime |
| Codex SessionEnd hook (session capture only) | user-global `hooks.json` + a config.toml trust entry under CODEX_HOME (both managed by bootstrap — codex hooks are silently inert without the trust entry) | at codex session end, machine-wide; `--no-hooks` opts out, `GBRAIN_HOOKS=0` disables |
| Memorable relay (OFF by default, disclosure-gated) | receipt + relay spawn from the session-end hooks / OpenClaw compaction; the third-party `memorable` CLI sends the redacted trace off-machine — see `docs/memorable-agents.md` | only after `gbrain config set integrations.memorable.enabled true` is accepted by a human; `GBRAIN_MEMORABLE=0` kills it |
| Per-turn persistence | Stop hook → debounced, detached scan-gated push (per workspace; 5 min default, every turn in cloud sandboxes) | after each assistant turn; `GBRAIN_STOP_PUSH=0` disables; `GBRAIN_STOP_PUSH_DEBOUNCE_MIN` / config `hooks.stop_push_debounce_min` tune it |
| Session persistence | SessionEnd hook → scan-gated commit+push | at session end (note: the harness never fires SessionEnd on `/exit` — the per-turn push is what covers that) |
| Compaction checkpoints | PreCompact hook → secret-scanned boundary segment banked to the corpus dir; a live serve harvests it into facts + `brain://` links (see `docs/guides/checkpoint-compaction.md`) | at each Claude Code compaction; links render as `## Compaction checkpoints` on the post-compaction session start |
| Push-failure visibility | next turn's context + a user-visible notice; re-announces every 30 min while failing | whenever a background push fails |
| Optional background job (consent-gated) | git post-commit auto-push + launchd/cron 30-min pull (pull job skipped honestly on hosts without a scheduler) | while logged in |
| Private GitHub repo | your account, created by `bootstrap repo` (or an empty repo you made yourself, adopted) | privacy verified via API |
| Machine receipt | `~/.gbrain/bootstrap/receipt.json` | uninstall is keyed to it |

**What does NOT run:** anything while the harness is closed. Session-triggered
schedules fire at turn/session boundaries only. True 24/7 operation is what a
hosted brain provides — this is the honest desktop contract.

## Cloud sandboxes (claude.ai/code and similar)

Cloud sessions run in a reclaimed-after-inactivity VM behind a
credential-injecting egress proxy. `gbrain bootstrap status --json` reports
`execution_environment: "cloud-sandbox"` there, and the install adapts:

- **Hooks live in the committed `.claude/settings.json`** with PATH-resolved,
  fail-open commands (no machine paths). The gitignored local settings file
  never survives into the next session's fresh clone, and hook config is
  snapshotted at session start — so hooks written mid-session go live on the
  NEXT session. Commit and push the file.
- **The per-turn push runs every turn** (debounce 0) — a reclaimed VM's tail
  loss is permanent, so each turn banks to the private repo.
- **Repo-privacy verification falls back to pure git protocol** when the proxy
  blocks the GitHub API (GraphQL is always pinned there; REST reaches only
  session-attached repos). Confirmed-public origins still always refuse.
- **Repo creation is refused in cloud** with the flow that works: create the
  private repo from a normal machine or github.com, open the cloud session ON
  that repo, run `gbrain bootstrap attach`.
- **The gbrain binary installs via the environment setup script** — print it
  with `gbrain bootstrap cloud-setup-script` and paste it into the environment
  config (npm-based; bun's package fetching is proxy-incompatible there).
- **No scheduler exists** — the consent-gated pull job is skipped with an
  honest message; event-driven pushes cover persistence.

Escape hatch for self-hosted git you trust (every use warns loudly):
the CLI flag on `sources push`, `GBRAIN_ALLOW_UNVERIFIED_REMOTE=1`, or
`gbrain config set push.allow_unverified_remote true` (file-plane — the only
form that reaches detached hook children inside a sandbox).

## Bring your own repo (create-repo-first)

By default bootstrap creates the private GitHub repo for you. If you prefer to own
that step — pick the name/org-under-your-account, or just work the familiar way —
create a new **empty** private repo **under your own GitHub account** (no
README/.gitignore/license), clone it, open the clone in your harness, and run the
bootstrap block. `gbrain bootstrap repo` detects the empty repo you created and
**adopts** it: it verifies the repo is private, sets a repo-local git identity, and
pushes your workspace. Two constraints, both enforced with a clear message rather
than a silent failure:

- **Empty.** A repo that already has commits (a README, a license, an existing
  project) is refused — create it empty, or run `gbrain bootstrap attach` if it is
  an existing agent workspace. (A repo already carrying *this* workspace's history,
  e.g. from an interrupted run, is recognized as yours and resumed.)
- **Personal account.** The repo must be owned by your authenticated GitHub user.
  Org-owned repos are refused today; create one under your own account, or let
  bootstrap make it.

Until the repo phase verifies the repo, the per-turn/session-end push stays
deferred — bootstrap never publishes your workspace to an origin whose privacy it
hasn't confirmed.

## The awake-when-you-are contract

Your agent is awake when your harness is. Laptop asleep = agent asleep. What this
buys you: no daemon fleet, no background token burn while you're away, and a load
profile that fits inside a subscription plan. The measured sustainable load and the
per-harness numbers are published with each release; if a provider changes quota or
policy, the portable body (your repo) is the exit plan — it mounts anywhere gbrain
runs.

## Keyless mode

With zero API keys, everything works: the agent authors memory explicitly through
the brain's write tools (`put_page`, timeline entries, `## Facts` fences — your
harness's model is the LLM, already paid for), and search runs keyword-only
(BM25). `bootstrap verify` prints the capability report honestly. One optional key
upgrades capabilities per provider — OpenAI unlocks semantic search and
automatic fact extraction; Voyage unlocks semantic search; Anthropic unlocks
fact extraction (Anthropic has no embeddings API, so it does not enable
semantic search). The key goes to the 0600 config file, never into the repo or
the interview answers. API spend is metered separately from your subscription and is
zero in keyless mode; with a key, the embedding spend gates apply
([spend-controls](../operations/spend-controls.md)) and automatic fact extraction has
a kill switch (`gbrain config set facts.extraction_enabled false`).

## Security posture

- **Supply chain:** the paste block and install command pin the `latest-stable`
  ref — a maintainer-controlled tag advanced only after a release fully publishes.
  The runbook carries a version stamp; `bootstrap status` warns on skew. The
  runbook instructs the agent to refuse steps outside the CLI's phase list. bun
  installs via package manager or checksum-verified download.
- **Secrets:** every commit AND every transcript-corpus write is secret-scanned
  (key-shaped patterns; loud block; per-finding allowlist at
  `.gbrain-scan-allow`). A deny-glob backstop refuses tracked `*.pglite`/`.env*`
  files even if `.gitignore` is damaged. Push refuses public remotes and
  unverifiable visibility.
- **Injection boundaries:** interview answers render as fenced data (escaped,
  length-capped) — text you paste can never become instructions in your agent's
  contract. Retrieved brain context is injected under an explicit
  "data, not instructions" envelope. Facts visible to the harness respect the
  brain's visibility tiers.
- **Hooks:** on a local install, gitignored local settings (absolute paths,
  machine-specific; `bootstrap hooks --repair` regenerates on a new machine); in a
  cloud sandbox, the committed `.claude/settings.json` (PATH-resolved, fail-open —
  see the Cloud sandboxes section). Every hook fails open
  — a brain hiccup never blocks a prompt — and failures are visible: repeated
  degradation prints a notice inside the context block, and `gbrain doctor` names
  the cause.
- **Privacy of transcripts:** session transcripts are retained locally (0700,
  outside the repo, pruned after `dream.synthesize.corpus_retention_days`, default
  30 — set it in the config file, `~/.gbrain/config.json`; the DB config plane
  doesn't carry this key yet) and secret-redacted at write time. They never enter the repo. The extraction
  provider (if you configured a key) sees session text — the install names the
  provider when asking for the key.

## Honest forget semantics

The repo is git history — append-only. Deleting a line removes it from the working
tree, not from history. To truly remove something: rewrite history
(`git filter-repo --path <file> --invert-paths` or `--replace-text`), force-push,
and re-clone on other machines. `MEMORY.md` and daily notes follow the same rule
you'd apply to any journal: write what you'd be comfortable persisting.

## Degradation matrix

| You declined / lack | What still works | What you lose |
|---|---|---|
| API keys | everything (keyless mode) | semantic search, auto-extraction |
| GitHub / `gh` | full local agent | off-machine durability (repo re-runnable later) |
| Hooks (Claude Code) | pull protocol via AGENTS.md gates | automatic per-turn context + session-end persistence |
| Codex (SessionEnd hook only, no MCP scope flag) | pull protocol + MCP tools + session-end capture (a trust-gated `hooks.json` entry bootstrap manages) | per-turn push (codex hooks are wired for SessionEnd only — per-turn context stays the pull protocol) + the ability to confine MCP reach to one folder (`codex mcp add` is always user-global) |
| opencode (no wired hooks; scope INVERTED: user-global by default) | pull protocol (opencode reads AGENTS.md natively) + MCP tools; project scope available as an explicit opt-in | per-turn push (opencode ships a plugin/event system, but gbrain does not wire it yet). The project-scope default is deliberately NOT offered: opencode spawns project-config servers with no trust prompt, so a committed entry would auto-execute on every collaborator machine |
| Bootstrap at all (plugin-only install) | MCP tools (`starter` surface, `--source-guard`) + the curated skill set via the codex/claude plugin (docs/mcp/CODEX.md) | identity files, hooks/push protocol, the private-repo body — the plugin is the lightweight lane; bootstrap is the full agent |
| Memorable relay (declined or never disclosed) | everything — the integration is additive and off by default | replayable cross-session procedures via the third-party Memorable service (`docs/memorable-agents.md`) |
| Second simultaneous session | first session unaffected | second session's brain tools fail politely (one live serve per brain — v1 contract) |
| Postgres brain (incl. harness mode) | MCP tools every session + pull protocol | per-turn hook injection (`no_pglite_path`: the hook IPC socket is PGLite-only today; hooks stay pre-wired and light up when the engine-uniform listener lands). Preferring Postgres — e.g. via `gbrain init --prefer-postgres` — deliberately trades the per-turn hook lane for MCP-every-session plus the pull protocol until that listener lands; a documented tradeoff, not an oversight |

## Local harness mode (`gbrain bootstrap harness`, #4043)

The workspace install above is built for a human's laptop. A box run by an
agent framework (your OpenClaw, or anything that shells out to `claude -p` /
codex exec) already hosts a brain and a running `gbrain serve --http` — and
those framework-spawned sessions get zero brain access by default. Harness
mode wires them in one command, with no `agent.json` and no interview:

    gbrain bootstrap harness --yes

- Mints a **least-privilege** bearer token (scopes `read+write`, stored in the
  `access_tokens.scopes` column; reads span the brain's federated sources).
  Re-runs rotate mint-first: the previous token is revoked by id only after
  the new one is wired and smoke-tested, so clients are never dead mid-swap.
  The smoke sends a deliberately invalid credential first — an endpoint that
  accepts anything is not this brain's serve — and a failed smoke rolls the
  wiring back (fresh registrations removed, replaced ones restored, the
  headless pre-approval stripped) and retires the fresh mint immediately, so
  nothing live is ever left pointed at an unverified endpoint. Prior wiring
  is only cleaned up after the replacement verifies.
- Claude Code: user-scope HTTP MCP registration, `mcp__gbrain` pre-approved in
  user-scope `permissions.allow` (headless `claude -p` blocks MCP tools
  without it), and the five lifecycle hooks — user scope by default, or
  exactly the dirs you pass with repeatable `--project` (never both; the two
  would double-fire every event). `--no-capture` wires context injection only
  and skips the transcript-capture events.
- Codex: one managed `[mcp_servers.gbrain]` block with the bearer token
  INLINE in the codex config (0600) — framework-spawned codex inherits no
  shell profile, so the env-var lane the `connect` path uses would never
  reach it. One owner per server name: if the gbrain codex PLUGIN is
  also enabled, two `gbrain` servers exist in different layers — the wire
  proceeds with a loud WARNING and `gbrain doctor` reports the collision
  (`plugin_lane_collision`); keep one (`codex plugin remove gbrain@gbrain`, or
  `--remove` here). Unless `--no-hooks`, the harness lane also installs the
  codex SessionEnd capture hook — the user-global `hooks.json` entry plus its
  `config.toml` trust entry beside the target config (codex hooks are silently
  inert without the trust pair; the write backs the config up to
  `<config.toml>.hooks.bak`), machine-global by nature; `--remove` tears it
  down along with the MCP block.
- opencode: one managed `mcp.gbrain` remote entry with the bearer header
  INLINE in the user-global JSONC config (0600), written by the same
  comment-preserving editor the workspace lane uses — the `{env:…}`
  interpolation the `connect` path prefers would resolve empty under a
  framework-spawned opencode for the same no-shell-profile reason.
  Note: downgrading gbrain below the release that introduced opencode support
  after wiring it leaves the opencode entry in place for manual removal —
  edit the opencode config by hand, or re-upgrade and run
  `gbrain bootstrap harness --remove`.
- Honesty on Postgres brains: per-turn injection is degraded (the matrix row
  above); MCP is the active seam and the summary says so.
- `--status [--json]` probes the live truth (serve health, token validity via
  host-config recovery — the Claude Code lane only recovers a bearer from a
  registration whose URL matches the receipt; the codex managed block is read
  from the exact path the receipt records — and per-target states) with a
  cron-honest exit contract: 0 only when the serve, token, and every target
  verify and the rotation has converged (honest degrades count as OK); 1 on
  an unreachable serve, a failed token verify, failed or pending targets, an
  unconverged rotation, or a half-removed install whose token still awaits
  revocation. With no install at all it says so and exits 0 (2 under
  `--json`, so machine callers can tell absence apart). `gbrain doctor`
  carries a matching `bootstrap_harness_health` check. `--json` on the
  install itself emits a single machine-readable document on stdout (prose
  goes to stderr).
- The full flag surface lives in `gbrain bootstrap --help`: `--url`/`--port`
  point at a non-default serve (a non-loopback `--url` is refused unless you
  also pass `--token`, which flips into registrar mode — MCP wiring only, no
  hooks, nothing minted), `--force` replaces a foreign same-name MCP
  registration, `--name` renames the server, `--harness` picks the hosts,
  and `--no-hooks` skips hook wiring entirely.
- `--remove` tears down exactly what the machine-level receipt
  (`<home>/bootstrap/harness.json`) records — host removals are engine-free
  and run even while a serve is live; the token revoke defers with exact
  instructions if a live PGLite serve holds the brain. `gbrain bootstrap
  uninstall` removes harness wiring first, automatically.
- Everything is stated before it happens; non-interactive runs require
  `--yes`. Close active Claude Code sessions for the cleanest user-scope
  settings writes (the host also writes that file).

PGLite note: minting needs the single-writer lock, so on a PGLite brain
either pre-mint (`gbrain auth create bootstrap-harness --scopes read,write`
while the serve is stopped) and pass `--token`, or stop/re-run/restart.
Postgres brains mint fine while the serve runs. A token you supply is never
revoked by `--remove` or rotation (it is not the harness's to revoke) —
retire it yourself with `gbrain auth revoke` when you're done with it.

Binary-downgrade note: token scoping is data-only (no migration), so a gbrain
binary OLDER than the release that shipped it verifies every scoped token as
FULL-ACCESS — the old verify path never reads the scopes column. If you
downgrade after a harness install, revoke the scoped tokens first
(`gbrain auth revoke` with the id flag) and re-mint once you upgrade again.

## Multi-device

Clone your agent repo on machine two and run `gbrain bootstrap attach` — it
validates the manifest, wires this machine (source registration, hooks repair,
MCP), and verifies. The brain database is derived state, rebuilt from `brain/` +
re-ingestion; hot facts extracted only on machine one arrive via the repo's pages
and fences. Simultaneous editing from two machines is ordinary git conflict
territory — `sources push` pulls divergence-safely (commit first, rebase pull,
loud on conflicts).

## Uninstall

`gbrain bootstrap uninstall` removes exactly what this machine's install receipt
records: hook wiring, MCP registrations (surgically — foreign servers and hooks
survive), and bootstrap-created state. Your repo is never touched — the body
remains yours. The brain database is KEPT by default; `--delete-brain` is offered
only when bootstrap created the brain, offers a facts export first, and enumerates
what it is about to remove. It refuses to run while a session's serve is live.

## If something seems broken

One command: `gbrain doctor`. It covers hook health, push staleness, serve/lock
collisions, schema state, and prints fixes. `gbrain bootstrap status --json` emits
a support blob (versions, harness, last verify/push, hook failure rate) your agent
can relay verbatim when you report a problem.

## Real-agent e2e

Most bootstrap tests drive the dispatcher with PATH-shimmed `claude`/`codex`
recorders — fast, hermetic, no API cost. Two additional "door" tests drive the
ACTUAL binaries end to end so we catch real-world drift (a `codex mcp add` flag
that changed shape, a harness that stopped calling our MCP server):

- `test/e2e/bootstrap-real-claude.serial.test.ts` — real `claude -p` over MCP.
- `test/e2e/bootstrap-real-codex.serial.test.ts` — real `codex exec`. It runs the
  keyless-`init` → interview → render → `gbrain bootstrap hooks --harness codex`
  path (executing the real `codex mcp add` into a hermetic `~/.codex/config.toml`),
  asserts the rendered `AGENTS.md` carries the Gate-3 brain-first pull protocol
  (the pull protocol is codex's per-turn seam; the SessionEnd capture hook is
  wired separately, and the door asserts its trust-gated hooks.json + config.toml
  pair landed), then
  spends one live `codex exec` turn to prove real codex → gbrain MCP → brain →
  a seeded, brain-only fact (falling back to a shell `gbrain query` if headless
  stdio-MCP is unavailable).

opencode's real-binary door lives in
`test/e2e/install-real-opencode.serial.test.ts` (its writer-parity leg
handshakes gbrain's direct JSONC registration through the actual binary);
`docs/TESTING.md` carries the full door inventory and cadence policy.

These pay real API cost and take 30s–2min per turn, so they are NOT in the PR
shard. Everything is hermetic (temp `HOME` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR` /
`GBRAIN_HOME` per test — the operator's real `~/.claude`, `~/.gbrain`, `~/.codex`
are never touched; auth is copied read-only). Each file self-SKIPS via
`describe.skipIf` when its binary or auth is absent, so on a machine without the
tool it is a clean no-op that never fails. CI wires them into the `real-agent-e2e`
job in `.github/workflows/heavy-tests.yml` (nightly + the `real-agent-e2e` /
`heavy-tests` label); on a stock runner they self-skip. To actually exercise the
binaries you need a runner with authed `claude`/`codex` and the provider creds
(`GSTACK_ANTHROPIC_API_KEY`/`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`) exported.

Run locally (where both are installed + authed):

```bash
bun test test/e2e/bootstrap-real-codex.serial.test.ts
```

## DX exploration harness (developer instrument, not a test)

The door tests prove the install WORKS; they say nothing about how it FEELS.
`test/helpers/tty-harness.ts` spawns any CLI (gbrain, `claude`, `codex`, `grok`, `opencode`) under a
real pseudo-terminal (Bun's `terminal:` spawn option) and records every output
burst with a millisecond timestamp, so unnecessary pauses become a measurable
artifact (`computeStalls` → `stalls.md`) instead of a vibe. Same hermetic env as
`agent-harness.ts`; pure helpers are unit-tested in `test/tty-harness.test.ts`
(zero subprocesses, PTY smokes self-skip where `terminal:` is unavailable).
The harness itself also backs one required-CI test: `test/init-picker-pty.serial.test.ts`
asserts the interactive `gbrain init` pickers under a real PTY (see the
TTY decision table in `docs/TESTING.md`). The DX-exploration layer below stays
an instrument — nothing in it asserts.

`scripts/dx-explore.ts` drives it to capture the fresh-user funnel as timestamped
transcripts under `.context/dx-runs/` (gitignored — nothing asserts, no CI):

```bash
bun run scripts/dx-explore.ts help              # comprehension surfaces (no keys)
bun run scripts/dx-explore.ts init [--keyless]  # interactive init, naive-user autopilot
bun run scripts/dx-explore.ts claude-install    # REAL claude running the paste-in bootstrap
bun run scripts/dx-explore.ts codex-install     # REAL codex, same
bun run scripts/dx-explore.ts opencode-install  # REAL opencode running the paste-in bootstrap
bun run scripts/dx-explore.ts grok-install      # REAL grok, brain-only GROK.md install (no bootstrap path)
bun run scripts/dx-explore.ts drive -- gbrain init   # manual: steer a live TUI via a file channel
```

`drive` mode is how an agent in a Conductor workspace explores a live TUI across
separate tool calls: `cat <dir>/session/screen.txt` to watch, append
`{"line":"..."}` / `{"key":"Down"}` / `{"stop":true}` to `<dir>/session/input.jsonl`
to steer. Each run writes `meta.json`, `visible.txt`, `frames.jsonl`, and
`stalls.md`. `--keyless` strips provider keys so the true no-key first-touch path
is exercised (a Conductor session's ambient `ANTHROPIC_API_KEY` would otherwise
leak in). Install scenarios pay real API cost — launch them as background tasks.
