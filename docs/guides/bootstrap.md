# GBrain Bootstrap — your harness as your agent

`gbrain bootstrap` turns a Claude Code or Codex session into a persistent personal
agent: identity files rendered from your own answers, a local PGLite brain,
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
| Bootstrap-managed MCP registration (`gbrain serve`) | Claude Code: project scope by default; Codex: user-global (`codex mcp add` has no scope flag) | spawned by your harness per session |
| Hooks (Claude Code, ON by default) | local installs: `.claude/settings.local.json` (gitignored); cloud sandboxes: the COMMITTED `.claude/settings.json` (PATH-resolved, fail-open commands) | each prompt; fail-open; `--no-hooks` opts out at install, `GBRAIN_HOOKS=0` disables at runtime |
| Per-turn persistence | Stop hook → debounced, detached scan-gated push (per workspace; 5 min default, every turn in cloud sandboxes) | after each assistant turn; `GBRAIN_STOP_PUSH=0` disables; `GBRAIN_STOP_PUSH_DEBOUNCE_MIN` / config `hooks.stop_push_debounce_min` tune it |
| Session persistence | SessionEnd hook → scan-gated commit+push | at session end (note: the harness never fires SessionEnd on `/exit` — the per-turn push is what covers that) |
| Push-failure visibility | next turn's context + a user-visible notice; re-announces every 30 min while failing | whenever a background push fails |
| Optional background job (consent-gated) | git post-commit auto-push + launchd/cron 30-min pull (pull job skipped honestly on hosts without a scheduler) | while logged in |
| Private GitHub repo | your account, created by `bootstrap repo` (or an empty repo you made yourself, adopted) | privacy verified via API |
| Machine receipt | `~/.gbrain/bootstrap/receipt.json` | uninstall is keyed to it |

### Adopting independently managed project Codex wiring

Bootstrap's normal Codex writer still uses `codex mcp add`, whose registration
is user-global. If you instead manage an enabled streamable-HTTP server in this
workspace's `.codex/config.toml`, make one real MCP call first, then adopt it:

```bash
gbrain bootstrap wire --adopt --harness codex --scope project \
  --name <server> --attest-runtime-call
```

Config detection alone leaves the wire phase `partial`; it does not prove a
working connection. Adoption writes only a secret-free structural fingerprint
(transport, credential-free endpoint location, auth/header presence, and
selected behavior) plus explicit operator attestation to machine-local,
non-owning evidence. Header values, URL credentials/query/fragment, tokens, and
client secrets are excluded. It does not add the server to bootstrap's install
receipt, and `bootstrap uninstall` will not remove the project config.

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
(OpenAI, Anthropic, or Voyage) unlocks semantic search and automatic fact
extraction; the key goes to the 0600 config file, never into the repo or the
interview answers. API spend is metered separately from your subscription and is
zero in keyless mode; with a key, the standard spend gates apply
([spend-controls](../operations/spend-controls.md)).

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
| Codex (no lifecycle hooks; bootstrap-managed `codex mcp add` is user-global) | pull protocol + MCP tools; independently managed project-scoped HTTP config can be adopted after a real call | automatic per-turn push; folder confinement requires the independently managed project-config path above rather than bootstrap's managed registration |
| Second simultaneous session | first session unaffected | second session's brain tools fail politely (one live serve per brain — v1 contract) |

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
  (Codex has no hook system, so the pull protocol is its per-turn seam), then
  spends one live `codex exec` turn to prove real codex → gbrain MCP → brain →
  a seeded, brain-only fact (falling back to a shell `gbrain query` if headless
  stdio-MCP is unavailable).

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
