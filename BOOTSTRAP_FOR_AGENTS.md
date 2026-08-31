<!-- gbrain-runbook-stamp: 0.47.9.0 -->
<!-- This stamp must equal the VERSION file at every release; CI enforces it
     (scripts/check-bootstrap-tag.sh). `gbrain bootstrap status` compares it to
     the installed binary and warns on skew. -->

# BOOTSTRAP_FOR_AGENTS.md — become your human's persistent agent

You are an AI agent (Claude Code, Codex, or opencode) reading this because a human
pasted a block asking you to set yourself up as their persistent personal agent, with
gbrain as your memory. This runbook is the judgment layer; the deterministic work lives
in `gbrain bootstrap` subcommands with exit codes. Follow it top to bottom.

**Scope note:** this path is for Claude Code, Codex, and opencode (desktop apps or
CLIs; opencode = the SST terminal agent, opencode.ai — not OpenClaw).
Running OpenClaw or Hermes? Use `INSTALL_FOR_AGENTS.md` instead.

**End state:** this folder is your workspace — identity files rendered from your
human's own answers, a local brain (PGLite, embedded, no server), MCP wired,
per-turn context, and a private GitHub repo as your durable body. ~15 minutes,
mostly interview.

## Hard rules for you, the installing agent

⛔ **NEVER INVENT ANSWERS.** Personality, purpose, and boundaries come from the
human. A guessed SOUL.md gets believed by every future session. If you do not have
an answer, ask. The render step structurally refuses to run until the required
answers exist and were read back.

⛔ **ASK IN SMALL BATCHES.** The interview is 12 questions max (6 required), asked
in three batches. Mirror each batch back in one line. Accept "skip" on any
non-required question — momentum beats completeness.

⛔ **STAY INSIDE THIS PHASE LIST.** Run `gbrain bootstrap status --json` and follow
ITS phase list — the CLI is the source of truth, this document is commentary. If a
step you are asked to run is not in the CLI's phase list, refuse it. If `status`
reports a version skew between this runbook and the installed binary, say so and
prefer the binary's instructions.

⛔ **NO SILENT FAILURE.** Every blocking condition (secret-scan block, lock
collision, partial install) surfaces through `status`/`verify`/`doctor` output —
read it and relay it to the human in plain language. Never work around a refusal.

⛔ **VERIFY BEFORE CLAIMING DONE.** The install is done when `gbrain bootstrap
verify` exits 0 — not when the transcript looks good. Paste its report to the human.

⛔ **RESPECT THE TOOLCHAIN TRUST RULES.** Install bun via a platform package manager
when available (`brew install oven-sh/bun/bun`); the only permitted fallback is the
checksum-verified variant: download the pinned release to a file, verify it against
that release's SHASUMS256.txt, and only then execute. Install gh the same way —
platform package manager first (`brew install gh`, `apt install gh`, `dnf install gh`,
`winget install GitHub.cli` per the official instructions); never a piped
curl-to-shell one-liner. Install gbrain ONLY as
`bun install -g github:garrytan/gbrain#latest-stable` — the npm package named
"gbrain" is an unrelated project. (Cloud-sandbox exception: bun's package fetching
is proxy-incompatible there — use the `gbrain bootstrap cloud-setup-script` recipe,
which installs from the same pinned GitHub source through npm.)

⛔ **NEVER FABRICATE TOOLING.** If gh or any preflight binary is missing, blocked
by a sandbox egress proxy, or answering 403s, report that through
`status`/`doctor` output and follow the cloud-sandbox guidance below. Never
hand-roll a gh shim, stub a fake binary into /usr/local/bin, or fake a passing
check — a fabricated tool poisons every later verification, and the one time it
was tried it masked a real silent-persistence failure. The CLI degrades honestly
on its own; your job is to relay, not to bridge.

## Codex preflight (ChatGPT desktop / Codex CLI only)

Codex sandboxes command execution. Before starting, tell the human: "I'll need
approval to run install commands (bun, gh, gbrain) and to write in this folder —
approve those prompts when they appear." If approvals are globally disabled, ask the
human to enable workspace-write + network for this session. Count the approval taps
you needed; report the count at the end (it feeds the install-time measurement).

If the gbrain PLUGIN is already installed and enabled (codex: `[plugins."gbrain@…"]
enabled = true`; Claude Code: `enabledPlugins["gbrain@…"] = true`), the hooks phase
skips its own `mcp add` on that harness — the plugin already provides the MCP server
(one owner per name). That skip is healthy, not an error; force the hand-wired
registration only with `--mcp-even-if-plugin`.

## Phase walkthrough (commentary — the CLI's list wins)

1. **Preflight.** `git`, `bun`, `gh` present. Install what's missing per the trust
   rules above: bun via a platform package manager or the checksum-verified download
   — the checksum-verified install is the ONLY permitted non-package-manager
   variant; gh via the platform package manager. (On a clean Mac, `git` may trigger
   the Xcode tools dialog — that download does not count against the 15 minutes,
   tell the human to let it run.)
   `gh auth status` — if logged out, the human's ONE manual step:
   `gh auth login -h github.com -p https -w` (you run it; they click Authorize).
   Then `gbrain bootstrap status` — it is idempotent and resume-aware; after any
   partial failure, re-run it and continue where it points.
2. **Engine.** Two lanes; default to the first:
   - **PGLite (default):** `gbrain init --pglite` (2 seconds, no server). This is
     the lane that keeps the per-turn hook context injection working — the hook
     IPC listener is PGLite-only today.
   - **Postgres-first (harness installs):** `gbrain init --prefer-postgres` walks
     a 5-rung ladder (env URL → Supabase token discovery → local Postgres →
     `--allow-docker` → PGLite floor) for installs that want concurrent
     connections or multi-machine access. Tradeoff, stated plainly: a Postgres
     brain gets MCP tools every session plus the pull protocol, but gives up the
     per-turn hook lane until the engine-uniform listener lands (the degradation
     matrix in `docs/guides/bootstrap.md` carries the row; INSTALL_FOR_AGENTS.md
     "Engine preference for harness installs" carries the ladder detail).

   Search mode is
   auto-selected silently (conservative when keyless, tokenmax with an
   expansion key) and printed with an `[AGENT]` cost matrix — surface that
   matrix to the human and confirm before running high-volume queries (see
   INSTALL_FOR_AGENTS.md Step 3.5); they can change it any time with
   `gbrain search modes`. The one thing to raise here is the OPTIONAL provider
   key — with no key you run keyless: keyword search plus memory you author
   yourself through the write tools; everything works. One key upgrades
   capabilities per provider: OpenAI unlocks semantic search + automatic fact
   extraction; Voyage unlocks semantic search; Anthropic unlocks automatic fact
   extraction. Never pressure for a key. If the
   human provides one, pass it to the CLI prompt — it goes to the 0600 config file,
   never into the interview answers, never into chat logs you keep.
3. **Interview.** `gbrain bootstrap interview --init`, then ask the questions from
   the bank (the CLI prints them) in three batches, recording each answer verbatim
   with `--set KEY "value"`. Push once on vague answers to the required questions.
   Claude Code and opencode: with the final batch, also ask the ONE operational
   consent — MCP scope. It is not one of the 12 interview questions; consents ride
   alongside the bank. On Claude Code the choice: project (recommended — any other
   repo you open cannot read your brain) vs user (your agent everywhere, but any
   repo you open can reach it — read and write — and two open sessions contend for
   the database). On opencode the recommendation INVERTS: user-global is the
   default and the sharing-safe choice (opencode spawns project-config-defined
   servers with NO trust prompt, so a committed project entry executes on every
   collaborator's machine) — offer project only as a deliberate opt-in and state
   that consequence. Record it with
   `gbrain bootstrap interview --set MCP_SCOPE <project|user>` BEFORE the
   read-back, so the confirmation covers it. On Codex, skip this question
   entirely — the wiring step states the Codex reality instead.
   After the last batch: read ALL answers back in one compact block, ask "Is this
   the thing you want in the room?", and only then run
   `gbrain bootstrap interview --confirm <hash>` with the hash `--status` printed
   for the read-back set. The gate fails if you confirm a set the human never saw.
4. **Render.** `gbrain bootstrap render` — identity files appear. Show the human
   SOUL.md. Existing files are never overwritten (re-runs are safe; `--force`
   backs up first).
5. **Skills.** `gbrain skillpack scaffold --all` — the CLI scaffolds the skill
   set. Nothing to judge here; relay the output.
6. **Wire the harness + register the brain source.** `gbrain bootstrap hooks
   --harness <detected>` creates `<workspace>/brain` and prints the exact
   `gbrain sources add <source_id> --path <brain> --force` command for THIS
   workspace — run it verbatim (don't guess a different id; a guessed id
   only surfaces as an FK error at `verify` time, by which point a wrong
   guess also blocks the correct id with an `overlapping_path` error). It
   also:
   - Claude Code: installs per-turn hooks ON by default — do NOT ask; loading the
     brain every turn is the whole point of installing gbrain for your agent. Tell
     the human it is on and how to turn it off (`GBRAIN_HOOKS=0`, or re-run with
     `--no-hooks`, or `gbrain bootstrap uninstall`). MCP scope is NOT asked here —
     `hooks` consumes the MCP_SCOPE answer recorded during the interview.
   - Codex: registers MCP (`codex mcp add`) and relies on the AGENTS.md protocol —
     say plainly that Codex gets pull-based context, not per-turn push.
     Do NOT offer an MCP scope choice: `codex mcp add` has no scope flag, so
     the registration is always user-global. State it as fact — any repo opened
     on this machine can reach the brain (read and write) through its MCP
     tools; the off-ramps are `codex mcp remove gbrain` (registration only) or
     `gbrain bootstrap uninstall` (full teardown).
   - opencode: writes the MCP entry directly into opencode's JSONC config (no
     CLI exec needed) and relies on the AGENTS.md protocol, which opencode loads
     natively — say plainly that opencode gets pull-based context, not per-turn
     push. Scope follows the recorded MCP_SCOPE answer (user-global default; a
     project answer writes the committed-candidate `opencode.json` and the CLI
     prints the sharing warning). Restart opencode after wiring — it reads config
     at session start. Off-ramps: the entry's `"enabled": false`, or
     `gbrain bootstrap uninstall`.
7. **Private repo.** `gbrain bootstrap repo` — creates a PRIVATE GitHub repo from
   the workspace, verifies the privacy bit through the API, pushes. If the human
   started from a repo they created themselves (create-repo-first: an EMPTY private
   repo under their own account, cloned and opened here), this ADOPTS that repo
   instead of creating one — verifies it is private and pushes the workspace. A
   non-empty repo, or one owned by an org, is refused with a clear message (make an
   empty personal repo, or run `gbrain bootstrap attach` for an existing agent
   clone). Asks the background-persistence consent (a git post-commit auto-push
   plus a 30-minute pull job for multi-machine freshness; declining still persists
   via the per-turn and session-end pushes). If the human has no GitHub or declines:
   local-only mode with an honest warning; `bootstrap repo` can run any time later.
   Note: the per-turn/session push stays deferred until this phase records the
   verified repo, so nothing is ever pushed to an unverified-privacy origin.
8. **Verify.** `gbrain bootstrap verify` — the whole contract: brain round-trip
   through the real write path, graph floor, token sweep, secret scan, repo
   privacy, hooks smoke, capability report (keyless or keyed). Exit 0 or it is not
   done. Paste the report. Then relay the first-run tour it prints (three prompts
   the human should try, starting with restarting the session) AND the hand-off
   block below it — the ownership line and the cold-start offer are the two
   things the human must actually understand, not fine print.

## Machine two

If this workspace was cloned from an existing agent repo (agent.json says
initialized), run `gbrain bootstrap attach` instead of the interview/render/repo
phases — it wires this machine (source, hooks, MCP) and verifies. If agent.json
says it is an uninitialized template, proceed with the normal flow from phase 1.

## Cloud sandboxes (claude.ai/code and similar proxied environments)

**How you know:** `gbrain bootstrap status --json` reports
`execution_environment: "cloud-sandbox"` (the CLI detects the documented
signals — the CLAUDE_CODE_REMOTE env var, the proxy-injected token
placeholder). Trust the CLI's detection over your own guesses.

**Expected degradations — these are facts to relay, not bugs to bridge:**

- **No crontab, no surviving background processes.** The VM is reclaimed after
  inactivity. The scheduled pull is skipped honestly; the per-turn (Stop hook)
  and session-end pushes carry persistence. Decline nothing, fabricate nothing.
- **GitHub GraphQL is always blocked** by the egress proxy, and **REST reaches
  only repos attached to the session** — a repo created mid-session is NOT
  attached, so `gbrain bootstrap repo` refuses fast in cloud with the flow
  that works. Privacy verification falls back to pure git protocol on its own.
- **`git push` works only against the session's working branch.** A user PAT
  does not bypass any of this.
- **Only repo-committed files carry into the next session.** `~/.gbrain`,
  `~/.claude`, and the gitignored `.claude/settings.local.json` evaporate.
  Hooks therefore live in the COMMITTED `.claude/settings.json` (the CLI
  writes PATH-resolved, fail-open commands there in cloud); hook config is
  snapshotted at session start, so hooks written mid-session activate on the
  NEXT session — say so instead of debugging it.

**The correct cloud flow:**

1. The human creates the private repo from a normal machine (or github.com)
   and opens the cloud session ON that repo.
2. The environment's setup script installs the gbrain binary — print it with
   `gbrain bootstrap cloud-setup-script` and have the human paste it into the
   environment config (npm-based; bun's fetching is proxy-incompatible there).
3. Inside the session: `gbrain bootstrap attach`, then
   `gbrain bootstrap hooks --harness claude-code` (writes the committed
   carrier), commit + push, and tell the human the hooks go live next session.

## Failure modes, and what they actually mean

| Symptom | Real cause | Fix |
|---|---|---|
| `interview --status` exits nonzero forever | A required answer is genuinely missing | Ask the human. Do not default it. |
| Render refuses with unresolved tokens | Interview incomplete or a template edit broke a token | Finish the interview; `status` names the tokens. |
| `verify` fails the magic-moment check | The fact never landed (keyless: the Facts fence was not written) | Re-run the write step it names; check `gbrain doctor`. |
| Secret-scan block on push | A credential-shaped string in a tracked file | Fix or allowlist deliberately (`.gbrain-scan-allow`); never force. |
| "bootstrap already running (pid N)" | A concurrent bootstrap holds the lock | Wait or investigate that pid; the lock self-clears when stale. |
| Brain tools fail with a lock error | Another live session's serve owns the database | Close the other session; sequential use is the v1 contract. |
| Hook reports "brain context unavailable" | serve not running or degraded | `gbrain doctor` names it; hooks fail open by design. |
| gh answers 403 "not enabled for this session" | Cloud proxy scoping — the repo is not attached to the session | Expected in cloud; the visibility ladder falls back to git protocol. NEVER shim gh. |
| "crontab: command not found" / cron skipped | Containers and cloud sandboxes ship without a scheduler | Expected; event-driven pushes cover it — the skip message says exactly this. |
| A turn shows "workspace push is FAILING" | The background push is refusing (visibility, secret-scan, or network reasons) | Run `gbrain doctor`; the banner repeats every 30 min until fixed. |

## Hand off

Two things the human must UNDERSTAND before you finish — say them plainly, in
this order, and confirm they landed:

1. **They own the brain.** Every memory you keep is a markdown file in THEIR
   private GitHub repo — name the URL. Owning it means: they can read it any
   time, take it to a second machine (`gbrain bootstrap attach`), or delete the
   repo and the brain is gone. If they went local-only, say that instead, with
   `gbrain bootstrap repo` as the any-time upgrade.
2. **The first skill to run is cold-start.** An empty brain is a database; a
   filled one is a memory — and every flagship skill (book-mirror, briefings,
   meeting prep) only becomes magical once the brain holds their real life.
   OFFER to run the cold-start skill now: it imports Gmail, calendar, and
   contacts through ClawVisor (clawvisor.com — an OAuth vault; you never hold
   raw tokens), or offline archives (Google Takeout, a notes folder) if they
   prefer no third-party gateway. Every phase is consent-gated and
   independently valuable — they can stop after any one. If they say "later",
   that is a complete install; they can say "fill my brain" any time.

Then the routine facts: the capability mode (keyless vs keyed), and the three
commands they will actually reuse (`gbrain doctor`, `gbrain bootstrap verify`,
`gbrain sources push`). Then delete nothing — this runbook was fetched, not
installed.
