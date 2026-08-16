# Agent Bootstrap — Implementation Plan (normative)

The engineering source of truth for `gbrain bootstrap` — the paste-in install that
turns Claude Code / Codex desktop apps into a persistent personal agent (identity +
memory + skills + session-triggered schedules + private-repo persistence + local
PGLite brain). Product scope/sequencing source of truth:
[AGENT_BOOTSTRAP_DESIGN.md](AGENT_BOOTSTRAP_DESIGN.md). Where they disagree, the
design doc wins on scope; this doc wins on implementation.

Reviews absorbed: 3-designer panel + adversarial critique; product design review (3
rounds); CEO review (SELECTIVE EXPANSION, ~55 findings); outside voice x2 (37
findings, 35 accepted); eng review (32 findings). All accepted fixes are inlined
below with their finding IDs. 0 unresolved decisions.

---

## As-shipped deltas (read this first — where the code moved after the plan froze)

This plan is layered: later absorption sections (the post-design-review deltas, the
CX2 series) override earlier prose, and THIS section overrides everything below it.
The shipped implementation matches the plan except for these deltas:

1. **Verify runs LAST, not before host registration.** [CX2-5]'s determinism goal
   survived, but the shipped phase order (single TS source:
   `src/core/bootstrap/status.ts` `PHASES`) is
   preflight → engine → interview → render → skills → wire → repo → **verify**,
   and verify runs in-process on the caller-held engine, calling
   `runMaintenanceSweep` directly — no transient serve. It works pre-registration
   AND as the weekly re-run (`src/core/bootstrap/verify.ts`).
2. **Uninstall scope: [CX2-12] wins over the CEO-expansion bullet.** `~/.gbrain` is
   NEVER deleted wholesale — only receipt-enumerated bootstrap-created state
   (`src/core/bootstrap/uninstall.ts`).
3. **Module naming/layout:** `private-repo.ts` shipped as `repo.ts`; additional
   shipped modules the artifact table doesn't list: `attach.ts, assets.ts,
   format.ts, host-specs.ts, hooks.ts, lock.ts, status.ts, template-repo.ts,
   uninstall.ts`.
4. **Templates layout:** all bootstrap templates live under `templates/bootstrap/`
   (not at `templates/` root).
5. **Test filenames:** `test/hook-command.serial.test.ts` and
   `test/e2e/bootstrap-*.serial.test.ts` — the `.serial` variants the plan's own
   [A7] mandated; the artifact table predates that.
6. **README ordering:** the D5 placement was superseded by the 2026-08-09 user
   decision — per-harness `## Install` sections ordered Codex → Claude Code →
   OpenClaw/Hermes, with `INSTALL_FOR_AGENTS.md` living inside the OpenClaw/Hermes
   section (annotated in the artifact table; the D5 prose at the bottom is stale).

## Post-design-review deltas (2026-08-07, /office-hours APPROVED — these override below)

Product: **"GBrain for Codex" + "GBrain for Claude Code"** (names contingent on
trademark review) — the free desktop tier of the hosted-gbrain ladder (the hosted service is the
graduation path; the desktop ceiling is the mechanic, not a bug). Target surfaces are
the DESKTOP APPS; **Codex door ships first** (named pilot user is a non-developer
ChatGPT-app user). CLIs come along via shared machinery.

**Build order (replaces the PR1/FF phasing below where they conflict):**
0. **Spike (gates door-1 ship; starts immediately, before build):** clean-machine
   reproduction of Garry's working Codex-in-ChatGPT + gbrain prototype. Exit questions
   with pass bars: (#1 blocking) reliable per-turn/per-session WRITE trigger — 0
   durable-write failures in 20 sessions across ≥3 days on a non-founder machine, else
   extend to 50; causes logged. (#2) per-turn READ seam — context block present at turn
   start or degraded pull-mode documented. Also: folder access, MCP registration path,
   approval-tap count, connector availability (yes/no/degraded). PLUS in parallel: the
   **quota release gate** measured against Garry's production usage — pass: p90 day
   ≤10% of weekly Max/Pro quota; failure = scope change to "session-agent, no schedules
   by default" BEFORE schedule build effort. Codex CLI is NOT spike-gated.
1. **Shared body + engine machinery (PR1):** everything in this plan's PR1 (bootstrap
   family, gbrain hook + IPC turn_context, templates, question bank, secret scan,
   sources push, skillpack scaffold wiring, doctor checks) PLUS: `agent.json` repo
   manifest with `format_version: 1` (the ladder contract — the hosted gbrain service mounts this
   format; compatibility is a test, not a hope); wire EXISTING import + entity
   extraction + backlinks + graph-aware query into install/verify (funds design
   Premises 4/6 — new verify check: ≥1 entity extracted, ≥1 backlink resolved, one
   edge-only query answered); byte floors scaled to answered-question count (they catch
   skipped interviews, NOT invention — never pressure padding); commit this plan to
   docs/designs/AGENT_BOOTSTRAP_PLAN.md.
2. **Codex door (ships first):** runbook variant for Codex desktop approvals/sandbox
   (seam per spike; fallback = mandated MCP writes via AGENTS.md gates + end-of-session
   sweep, shipped only with measured reliability) + Codex CLI path (AGENTS.md pull
   protocol; session-start gate includes "run due jobs"). Connector-ingest capability
   probe wired into install output; connector ingest itself is v1.1.
3. **Claude Code door:** hooks per this plan (SessionStart/UserPromptSubmit/SessionEnd
   via serve IPC), MCP project-scope default, transcript ingestion. Includes the v1
   schedule mechanism: hook layer checks HEARTBEAT.md due-job list at session start +
   turn boundaries. If the spike finds no turn-boundary trigger on ChatGPT desktop,
   schedules are Claude-Code-only in v1 and per-surface copy says so.
4. **Graduation seam, desktop half only:** format spec + documented upgrade path +
   honest-contract copy. The "outgrowing this laptop" advisor nudge moves to v1.1
   WITH the hosted mount (never point at a destination that can't accept the repo).

**New v1 requirements from the design review (fold into implementation):**
- Binary install is tag-pinned: `bun install -g github:garrytan/gbrain#<release-tag>`,
  same stamp as the runbook, so `bootstrap status` skew check is meaningful.
- Non-terminal-buyer error channel: every blocking condition (scan block, lock
  collision, partial install, verify fail) surfaces through the agent's reply channel
  (agent-readable status/verify/doctor output the runbook + AGENTS.md instruct the
  agent to relay; hook failures write a status file surfaced at session start).
- Both doors, one machine: shared brain, one live serve; installer detects + reuses
  existing registration; simultaneous-session collision fails politely, doctor names
  it, agent relays it. serve --attach lifts the limit later.
- state/ boundary: interview.json + mcp.json COMMITTED (machine-2 re-render must not
  hard-fail); *.local/caches/heartbeat files gitignored; DB never committed.
- OS scope v1: macOS + Linux (unix-socket IPC). Windows deferred (named-pipe = spike
  question if prioritized).
- Success criteria additions: TTFM ≤15 min EXCLUDING first-run toolchain downloads
  (published separately); door-2 developer test (README paste → ≤10 min install,
  week-two recall check); graph floor verify check; magic moment = deterministic
  retrieval assertion + scripted human confirmation (never fake-automated).
- Provider-policy drift acknowledged as unmitigable external risk; posture = quota
  gate + no absent-user background burn + portable body as exit plan.
- README: bootstrap paste block is the "full agent" option INSIDE the existing "Quick
  start: Claude Code or Codex" section; the 2-line memory-only quick start STAYS,
  labeled "just memory, no agent"; INSTALL_FOR_AGENTS.md remains the platform headline.
- Consolidated v1 non-goals (from design doc, amended by CEO review): connector ingest
  (v1.1), hosted mount + advisor nudge (v1.1), serve --attach, notify sweeper, Windows,
  networked-paste Docker e2e (fast-follows); 24/7 crons never on desktop.

**CEO-review accepted expansions (2026-08-07, SELECTIVE EXPANSION — now v1 scope):**
- **GitHub template repo** ("Use this template") as a second distribution artifact for
  the ChatGPT door (resolves design OQ2 = yes). Same rendered file set, published;
  kept in sync with templates/ by extending scripts/check-bootstrap-templates.sh to
  diff the template repo content. Build order 2.
- **`gbrain bootstrap uninstall`** in v1 (was fast-follow): removes MCP registration +
  hooks + bootstrap-created state (confirm-gated), leaves the repo ("the body remains
  yours"). [Scope superseded by CX2-12 + as-shipped delta 2: `~/.gbrain` is never
  deleted wholesale — only receipt-enumerated bootstrap-created state.]
- **Docker cold-machine e2e (offline parts) in CI** in v1: networkless read-only
  container running interview → render → verify with fake gh (codex-as-agent
  tests/docker shape). The full networked paste flow stays a fast-follow (flake).
- **Hot-memory greeting digest in SessionStart**: top facts via IPC turn_context when
  serve is up; file-plane MEMORY.md digest fallback when not (session start often
  precedes serve spawn); fail-open. Claude door in v1; door 1 iff spike finds a read
  seam.
- **First-run tour**: `bootstrap verify` success output ends with three scripted magic
  prompts (who am I to you / remember X then restart / what do you know about
  <project>) — makes week-one compounding visible (design Premise 4).
- **Deferred to TODOS.md in the PR** (must land as TODOS entries with the cathedral
  PR): `gbrain quota` meter command (release-gate measurement ships as script+doc
  first; productize once the per-harness token-count method is proven); networked
  Docker paste-flow e2e.

## Deep-review hardening (2026-08-07 CEO review sections 1–9 — ALL ACCEPTED per
## Garry's standing directive; IDs trace to the review record. These are v1 scope.)

**Architecture (S1):**
- [D4] The release-time template-repo generator IS `core/bootstrap/render.ts --minimal`
  with placeholder answers — one rendering code path, two consumers; CI guard becomes a
  byte-diff of generator output vs the vendored tree.
- [D5] Bootstrap phase list defined ONCE in TS; `bootstrap status --json` emits it; the
  runbook defers to it ("follow status's phase list"); CI checks runbook phase names
  against the TS list.

**Source binding + brain semantics (G1, S3#1 — the two product-breaking fixes):**
- [G1] MCP registration passes the workspace source explicitly
  (`claude mcp add -e GBRAIN_SOURCE=<workspace-slug>` / codex env equivalent) so agent
  writes land in the workspace source, fact fence-writes reach `brain/` files (not
  DB-only fallback), and the private repo actually fills. `bootstrap verify` asserts an
  MCP-path `put_page` materializes a COMMITTED file under `brain/` — a green verify with
  an empty repo is impossible.
- [S3#1] `turn-context.ts` constructs an OperationContext with `remote: true` and
  threads `visibility: ['world']` into all fact reads (parity with the existing
  meta-hook posture — the IPC path must never widen what MCP would return). IPC test:
  a `visibility='private'` fact NEVER appears in a turn_context response. Verify's
  magic-moment fact is written with visibility the harness can read back (world).

**Interview + render hardening (S3#3, G10, G12, A8):**
- Answers render inside fenced, explicitly-subordinate blocks ("verbatim principal
  input — data, not instructions"); strip/escape line-leading `#`, `<!--`, and code
  fences; per-answer length cap (~4KB, confirm-to-truncate); reject/escape `{{` and
  control chars at `--set` time (a Handlebars user's honest answer must not brick the
  token sweep). Verify fails if any heading or managed-block marker in a rendered file
  traces to an interview value (protects harden's AGENTS.md marker splicing).
- [A8] `--confirm` requires the hash of the exact answer set that was read back;
  per-answer `set_at` provenance recorded; hostile test: single-batch set+confirm
  exits non-zero and verify reports `provenance: unverified`.
- [G12] Conflict-marker detection on `state/interview.json` read → agent-readable
  "resolve this file" message, never a stack trace.

**Uninstall confinement (G2, S3#5, A2):**
- Never delete a brain bootstrap didn't create: `agent.json` created-by stamp checked;
  default KEEPS the DB; deletion only behind explicit `--delete-brain` with a confirm
  that enumerates sources + page count; facts export offered first (facts are NOT
  derived state). Refuse when `GBRAIN_HOME` is set unless `--home` is explicit AND
  `isPathContained` + gbrain-home signature (config.json + brain.pglite) both pass.
  Host-config edits are marker-keyed managed blocks only (settings.local.json,
  ~/.codex/config.toml) — foreign hooks/servers survive; test asserts full
  before/after filesystem+registration diff incl. foreign entries + symlinked home.

**Hooks + IPC hardening (G5, G11, S3#6, S3#7, S3#8, A9, A3):**
- [G5] `bootstrap hooks`/`--repair`/uninstall use marker-keyed managed-block
  read-merge-write on settings.local.json — never overwrite `permissions.allow` or
  foreign hooks; never append duplicates.
- [G11] IPC client timeout parameterized per kind (turn_context > 250ms default);
  window payload + assembled block clamped below the 256KB message cap before send.
- [ENG-1] **Claude Code hook-output cap:** stdout/additionalContext is capped at
  10,000 chars by the harness (overflow is diverted to a file and NOT injected) —
  the assembled turn_context block is budgeted to ≤8KB (pointers + facts trimmed by
  confidence to fit), asserted in the hook snapshot test. Docs: code.claude.com hooks
  reference (verified 2026-08-08; the hook writers are dated spec-targets, so this cap
  lives with the settings-shape module).

## Eng-review hardening (2026-08-08 /plan-eng-review — ALL ACCEPTED per standing
## directive; seams verified against source with file:line quotes)

- [ENG-2] (9/10) **cli.ts registration is THREE touchpoints, not one:** `CLI_ONLY` set
  (cli.ts:58), the engine-free if-chain inside `handleCliOnly` (add before the
  `connectEngine` terminator at cli.ts:1840), and `CLI_ONLY_SELF_HELP` (cli.ts:61 —
  omit it and the subcommands' `--help` is dead code, the documented init.ts:117 trap).
  `bootstrap`/`hook` must NOT enter `THIN_CLIENT_REFUSED_COMMANDS`. Membership test per
  the #2035 precedent (test/cli-bigint-normalize.test.ts:46 shape).
- [ENG-3] (9/10) **IPC widening = handler restructure, not a field add.** Correct path
  is `src/core/context/resolve-ipc.ts` (constants at :26-28). `ResolveHandler` is a
  single-function type (:42) and the server handler dispatches unconditionally
  (:127-128) — turn_context needs a discriminated-union request + handler map
  (restructuring the closure at src/mcp/server.ts:90-108), NAMED response types
  (today's responses are inline literals), and per-kind MAX_MSG_BYTES/CLIENT_TIMEOUT.
  Absent `kind` defaults to 'resolve'; old-serve grace confirmed (malformed → client
  IPC_UNAVAILABLE fail-soft, resolve-ipc.ts:80-84).
- [ENG-4] (8/10) **Postgres-hook silent degrade on unmigrated brains:** volunteer.ts
  (:247-249) and retrieval-reflex.ts (:180-183) swallow missing-table errors
  (pre-v110/v117), so a direct-engine hook returns empty, not an error. Fix: hook
  heartbeat records `degraded_reason: 'schema_pre_vNNN'`; doctor pairs
  hook-in-use + unmigrated-brain into a named warning.
- [ENG-5] (8/10) **Sweep layer ownership decided:** startup sweep attaches in
  src/mcp/server.ts immediately after `server.connect` (:77) in the same best-effort
  try/catch shape as the resolve-IPC block (:85-112), with cleanup added to shutdown
  (:122); the idle sweep lives in src/commands/serve.ts reusing the `armIdle` pattern
  (:437-451) through the injectable `deps.setInterval` seam (:281,297), every timer
  `unref()`d (the :424/:444 convention) so the sweep can never hold the process open.
- [ENG-6] (9/10) **Compiled-binary asset rule:** `bin/gbrain` ships via
  `bun build --compile`; `dirname(dirname(__dirname))` template resolution
  (init.ts:1514 pattern) breaks in the binary. Templates + questions.json + runbook
  stamps are STATICALLY IMPORTED (bundled) — same mechanism as the existing
  `skills/_brain-filing-rules.json` static import in brain-repo-durability.ts. A
  compiled-binary e2e asserts `bootstrap render` works with NO repo checkout present.
- [ENG-7] (7/10) **Host-format module precedents named:** registration strings follow
  connect.ts `AGENT_SPECS` + argv builders (:61-67, :262-267); file-writing hook/
  settings writers follow the integrations.ts / frontmatter-install-hook.ts idiom
  (backup + marker + restore). The dated-spec-target scaffold is imported from
  codex-as-agent (greenfield here — docs/plans/ has n=1 file); it becomes
  `src/core/bootstrap/host-specs.ts` with TARGETS entries carrying id/status/
  verifiedAt/references.
- [ENG-8] (9/10) **Facts visibility knob = ONE resolver helper.** The 'private'
  default is duplicated at backstop.ts:185, :352, operations.ts:4468, :5812 — and the
  :4468 ternary coerces any non-'world' to 'private', so a config default needs an
  explicit caller-unset check. Implement `resolveDefaultVisibility(engine)` (reads
  `facts.default_visibility` via the getConfig precedent, extract.ts:44) feeding
  ctx.visibility at ALL FOUR sites; no schema change (CHECK already permits 'world',
  migrate.ts:2319). Documented as security-relevant: it widens what remote/MCP
  callers read via meta-hook.ts:66 — the intended effect, stated as such.
- [ENG-9] (8/10) **Secret-scan module reuses residents:** seed exclusion list from
  `.gitleaks.toml` allowlist paths (test/, skills/, .claude/skills/) so the scanner
  doesn't fire on fixtures CI already ignores; findings render through
  `redactSecretsInText` (shell-redact.ts:36) for consistent `<REDACTED:name>` output.
- [ENG-10] (7/10) **Renderer must not eat intentional literals:** skillpack scaffolds
  carry a literal `{{output-from-skill}}` token (init-scaffold.ts:269) that must
  survive to disk — the renderer is never pointed at skillpack scaffold paths, pinned
  by a negative test.
- [ENG-11] (7/10) **turn_context reuses the existing hot-memory cache** (30s TTL keyed
  on source+session, meta-hook.ts) instead of a fresh facts query per turn — the
  per-turn cost profile is then identical to what every MCP tool call already pays.
- [ENG-tests] New tests from this review: CLI_ONLY membership (bootstrap, hook);
  compiled-binary render e2e (no repo checkout); Postgres-hook degraded_reason;
  resolveDefaultVisibility across all 4 call sites (unset/world/private × config);
  IPC handler-map dispatch (kind absent/resolve/turn_context/unknown); renderer
  negative test on scaffold literals; 8KB block-budget snapshot assert.
- [ENG-tests-2] Coverage-trace gaps (Section 3): **attach-mode e2e** (clone a
  bootstrap-created fixture repo on "machine 2" → attach → hooks repair → verify);
  **sweep tests** (bounded batch per idle tick, spend-gate off ⇒ no LLM calls,
  unref/shutdown never held open, corpus file marked processed exactly once);
  **keyless-mode e2e** (zero API keys: install → agent-authored fact via ops → BM25
  recall → magic-moment passes → capability report says keyless);
  **decline-everything e2e** (no gh, no keys, hooks declined: install completes
  local-only with honest warnings, verify exits 0-with-warnings, nothing silently
  broken).

## Eng outside-voice absorption (Codex round 2, 2026-08-08 — 17/17 ACCEPTED,
## all with file:line evidence; CX2 ids)

- [CX2-1 P0] **Template-vs-attach discriminator:** agent.json presence cannot
  discriminate a template clone from a machine-2 clone. The template ships
  `agent.json` with `initialized: false`; `bootstrap render` flips it true atomically
  AND writes a machine-local install receipt (`~/.gbrain/bootstrap/receipt.json`);
  `attach` requires `initialized: true`. [pairs with CX2-12]
- [CX2-2 P0] **One-live-serve wording clarified:** each door spawns its OWN stdio
  serve via its MCP registration (process-bound transport, server.ts:76); "reuse
  registration" means config, never process. v1 contract restated: one live serve at
  a time per brain; sequential across doors works; simultaneous fails politely.
- [CX2-3 P0] **Durability must be parent-repo-aware:** write-through targets
  `repo/brain` but hardening asserts `.git` in that exact dir (sources-harden.ts:83,
  brain-repo-durability.ts:621) — would fail on the workspace layout. Fix: durability
  resolves the repo root via `git rev-parse --show-toplevel` (the sync.ts:1002
  precedent); commit/push operate on the parent repo; integration test on the
  workspace fixture.
- [CX2-4 P0] **Keyless facts ingestion made deterministic:** put_page only queues
  extraction (operations.ts:1337); facts-fence reconciliation lives in the cycle
  extractor (extract-facts.ts:337). The serve sweep INCLUDES the zero-LLM facts-fence
  reconciliation pass, so agent-authored `## Facts` fences populate the facts table
  with no API key. Keyless e2e asserts it.
- [CX2-5 P0] **Graph-floor verify made deterministic:** verify cannot command the
  host's serve (stdio owned by the desktop app). Fix: the sweep gets a trusted
  local-only CLI entry (`gbrain sweep --once`, CLI_ONLY, never over MCP), and
  `bootstrap verify` runs BEFORE host registration on its own transient serve/engine:
  write via op → `sweep --once` → edge query. No timing nondeterminism.
  [Sequencing superseded by as-shipped delta 1: verify shipped as the LAST phase,
  in-process on the caller-held engine; the determinism goal is unchanged.]
- [CX2-6 P1] **Cross-platform lock replaces flock dependence:** flock(1) absent ⇒
  locking silently disabled (brain-repo-durability.ts:137) — macOS is the v1 target.
  One cross-platform lock (atomic mkdir/lockfile with PID+age+token semantics) spans
  scan → stage → commit → pull → push, coordinated with the post-commit hook.
  [As-shipped delta: a TOCTOU fix reordered the scanned phase to stage FIRST, then
  secret-scan the STAGED index blobs (`git cat-file`), so scanned bytes == committed
  bytes; unscannable staged blobs fail closed (`blocked_unscannable`). Lock span
  otherwise unchanged.]
- [CX2-7 P1] **Push ordering pinned:** commit FIRST, then divergenceSafePull, then
  push (the existing durability ordering, brain-repo-durability.ts:200 —
  divergenceSafePull returns skipped_dirty on a dirty tree, git-remote.ts:489); test:
  dirty local + advanced remote.
- [CX2-8 P1] **GBRAIN_HOME dual semantics normalized:** config appends `.gbrain`
  (config.ts:1210) while durability uses the value directly
  (brain-repo-durability.ts:95) — the S3#10 `ensureGbrainHome()` choke point is also
  the single semantic resolver; the --isolated e2e asserts the credential store's
  ACTUAL location is gitignored, not just the expected path.
- [CX2-9 P1] **Provider-key resolution re-specified honestly:** env legitimately
  overrides file config (config.ts:568) — the CX-P1.4 claim "never from shell env" is
  wrong. Real contract: interview-provided keys go to the 0600 config file so
  GUI-spawned serves (which lack shell env) find them; normal env>file precedence
  stands; test = GUI-launch simulation with empty env + file key.
- [CX2-10 P1] **IPC authorization, not just authentication:** turn_context binds
  server-side to the registered GBRAIN_SOURCE and rejects caller-supplied cross-source
  requests (existing handler accepts caller sourceId, server.ts:89); cross-source
  rejection test.
- [CX2-11 P1] **Hot-memory cache session key made real:** meta-hook reads an ad-hoc
  `source_session` that dispatch never sets (meta-hook.ts:49, dispatch.ts:208) — all
  callers collapse to the null-session cache key today. Session identity becomes
  typed OperationContext state set from MCP `_meta.session_id`; two-session isolation
  test.
- [CX2-12 P1] **Uninstall ownership = machine-local receipt** (never the repo-carried
  agent.json, which template/attach clones inherit); uninstall stops/refuses a live
  serve before touching state; `~/.gbrain` global config/sources/clones are NEVER
  deleted wholesale — only receipt-enumerated bootstrap-created state.
- [CX2-13 P1] **Committed-state hygiene:** the optional interview API key bypasses
  answers/hashes/provenance/logs entirely → written only to the 0600 config sink
  (config.ts:1138); committed `state/mcp.json` is the PORTABLE snippet (no absolute
  paths, no machine GBRAIN_HOME) — machine-specific wiring lives in local state and
  is regenerated by attach/`hooks --repair`.
- [CX2-14 P1] **Generator determinism:** template-repo renders use canonical
  placeholder provenance (frozen timestamps), exclude runtime state; guard test =
  two independent renders are byte-identical.
- [CX2-15 P1] **Two scan policies, not one:** the `.gitleaks.toml` allowlist is a CI
  fixture policy for a PUBLIC repo — importing it into the personal-repo runtime
  scanner creates blind spots (skills/ trees). Runtime scanner ships its own minimal
  allowlist + per-finding override; ENG-9 amended.
- [CX2-16 P1] **Bootstrap lock done properly:** atomic acquisition + PID liveness +
  age guard + ownership token (the pid-reuse learning applied); kill→immediate-rerun
  recovery test; export `LiveServeLockError` (currently unexported, pglite-lock.ts:28)
  so the planned class assertion can import it.
- [CX2-17 P2] **Format-aware host-config writers:** JSON has no comment-marker
  boundary — settings.local.json gets a structural JSON merger (gbrain entries keyed
  by a `_gbrain` marker property, semantic dup detection surviving reordering);
  config.toml gets a TOML-aware writer; both atomic write+backup; the
  frontmatter-install-hook replace/backup idiom applies only to whole-file targets.
  G5 amended.
- [S3#6] Socket binds in a 0700 dir with mode set BEFORE exposure; turn_context
  requires a shared secret from a 0600 file in the data dir; heartbeat counts
  turn_context serves so doctor can flag unexplained callers.
- [S3#7] Heartbeat JSONL schema pinned to counters + durations + error codes — NO
  prompt/fact/slug text; dir 0700; line cap; CI test greps fixture for keys outside
  the allowlist.
- [S3#8] `transcript_path` confined: `isPathContained(path, ~/.claude/projects)`,
  `.jsonl` + valid envelope on line 1, lstat-reject symlinks, byte cap.
- [A9] IPC request carries `protocol: 2`; hook treats a response lacking the protocol
  echo as "stale serve" and degrades LOUDLY (heartbeat entry + doctor warn); live test
  against a v1-shaped server.
- [A3] Session-start digest: explicit list of digest-eligible MEMORY.md sections
  (respecting the template's own security-boundary note); three-case test (socket up /
  socket absent / malformed MEMORY.md).

**Persistence + sync (G4, G6, G8, G9, G13, G14/A5, G15, S3#2, S3#10):**
- [G4] `hook session-start` checks for unpushed commits / dirty tree from crashed
  sessions, pushes, and names it in the greeting digest (SessionEnd is not the only
  persistence path anymore).
- [G6] Verify + every push gate run `git ls-files` against a deny-glob list
  (`*.pglite`, `.env*`, keys) — a truncated or pre-existing .gitignore can't leak.
- [G8] `bootstrap repo` creates a dedicated repo, OR adopts a pre-existing `origin`
  when the authed gh user owns it, no `repo_url` is recorded yet, and it is empty (or
  already carries our history) — the create-repo-first path; a foreign-content or
  org-owned origin is refused and pointed at attach. "couldn't verify visibility" is
  refuse-and-name-the-reason, never fail-open; idempotency keys off the remote URL,
  not the name probe.
- [G9] Workspace lockfile (pid+timestamp) makes concurrent `bootstrap` runs impossible;
  second run exits "bootstrap already running (pid N)".
- [G13] Fixed verify probe slug; sweep any prior probe before writing; excluded from
  retrieval; delete failure reported as a verify warning.
- [G14/A5] The ENTIRE `sources push` (add+commit+push) runs under the existing
  durability flock; single-flight test: N concurrent pushes → 1 winner, N-1 clean
  "skipped, push in flight" exits, zero leftover locks.
- [G15] Retention policy everywhere: MEMORY.md size cap in the template contract with
  rotation into `memory/reference/`; corpus pruned via
  `dream.synthesize.corpus_retention_days` (default 30); orphaned stop-hook buffers
  GC'd; doctor warns on all three.
- [S3#2] Secret scan runs at corpus-WRITE time (redact matched span + log redaction);
  bootstrap adds one consent line naming the extraction/embedding provider that will
  see session text.
- [S3#10] One `ensureGbrainHome()` choke point creates ~/.gbrain 0700 (all callers);
  brain-push.log 0600 + rotated; `--isolated` e2e asserts `git check-ignore
  .gbrain/git-credentials` passes and push never stages it.

**Transcripts (G3, A6):**
- Parser registered as a dated spec-target (same pattern as host-format writers);
  heartbeat logs parsed-turns/bytes; `bytes>0 && turns==0` raises a LOUD status-file
  failure ("the agent stopped learning" is never silent); scrubbed
  `claude-code.jsonl` fixture (tool_use/tool_result/thinking/image/sidechain/summary/
  compact-boundary shapes) added to `test/fixtures/conversation-formats/` and wired
  into `check:conversation-parser` + fixture-privacy guard; session-id-keyed corpus
  filenames prevent double-ingest on resume.

**Template repo (G7, S3#4, A1, C3):**
- Published ONLY from a CI release job (branch-protected, no direct pushes) behind the
  placeholder assertion + secret scan + privacy scripts run against the RENDERED
  artifact; fine-grained PAT secret scoped `contents:write` to the template repo only,
  documented in docs/RELEASING.md; version-job completeness check verifies template
  repo HEAD tree hash == vendored tree. Vendored rendered tree lives at
  `templates/bootstrap/template-repo/` — the CI guard diffs generator↔vendored OFFLINE
  (network comparison happens only in the release workflow). Template's first runbook
  step is `bootstrap status`, which hard-fails on a public `origin` before any
  identity file lands (closes the no-privacy-gate-on-this-door hole).

**Toolchain trust (S3#9):**
- Prefer platform package managers for bun/gh; curl fallback downloads to a file,
  verifies against the pinned bun release's SHASUMS256.txt, then executes; the
  runbook's phase allowlist names the verified form as the only permitted variant.

**Observability (B1–B5):**
- [B1] Append-only `~/.gbrain/bootstrap/install.jsonl` ({ts, phase, outcome,
  duration_ms, binary_version, harness, workspace}) written by every subcommand;
  `status` renders the tail.
- [B2] Every verify run persisted to `~/.gbrain/bootstrap/verify-<ts>.json` (keep 5);
  doctor reports last verify timestamp/status/deltas.
- [B3] Hook heartbeat records outcome + reason on EVERY invocation; trailing-20
  failure rate over threshold → one visible line inside the injected context block
  ("brain context unavailable for the last N turns — run `gbrain doctor`").
- [B4] `~/.gbrain/bootstrap/push-status.json`; doctor fails when last successful push
  >48h old with a dirty tree; surfaced in the SessionStart digest.
- [B5] `bootstrap status --json` emits a support blob (workspace, binary version,
  harness, engine, last verify, last push, hook failure rate); AGENTS.md instructs
  the agent to relay it verbatim on any "something's broken" report.

**Tests (A1–A9 not already covered above):**
- [A4] First-run tour prompts pinned in the questions.json↔template bijection guard +
  verify success-output snapshot test.
- [A7] Flake pinning: hook deadline asserted against an injected slow-IPC stub (real
  latency kept as non-gating benchmark); kill-mid-phase via deterministic
  `GBRAIN_BOOTSTRAP_ABORT_AFTER=<phase>` injection; lock-contention asserts on
  LiveServeLockError class; all subprocess tests named `*.serial.test.ts` with
  explicit --timeout; offline Docker e2e runs from heavy-tests.yml (nightly + label),
  not the PR shard matrix.

**Release mechanics (C1 RESOLVED + C2, C4, C5, C6, C8):**
- [C1 = D6-A, decided by Garry] **Distribution ref: single `latest-stable` ref.** The
  release job force-updates `latest-stable` to the just-verified release commit as its
  FINAL step (after binary assets publish + provenance attestation). README paste
  block, runbook URL, and `bun install -g github:garrytan/gbrain#latest-stable` all
  reference it permanently — no per-release tag pins, no 404 window, no per-ship
  README edits. The fetched runbook embeds the concrete VERSION it was cut from;
  `bootstrap status` compares that stamp to the installed binary (skew check intact).
  New guard `scripts/check-bootstrap-tag.sh`: README/runbook reference ONLY the
  sanctioned ref AND the runbook's embedded stamp equals VERSION. Modeled on
  test/release-workflow.test.ts.
- [C2] README.md + BOOTSTRAP_FOR_AGENTS.md re-admitted to `scripts/ci-cache-hash.sh`
  ALLOW_PATTERNS (a README-only paste-block change must never skip CI green).
- [C4/C5] `docs/designs/AGENT_BOOTSTRAP_PLAN.md` + a SCRUBBED
  `docs/designs/AGENT_BOOTSTRAP_DESIGN.md` (banned names → capability-class phrasing,
  founder quotes/pilot identifiers/pricing-funnel strategy removed) land in the SAME
  commit; normativity paragraphs point in-repo; `bash scripts/check-privacy.sh` run
  against the staged index before that commit.
- [C6] CHANGELOG states capabilities functionally ("installs hooks that run on each
  prompt; installs an opt-in background push job") linking to docs/guides/bootstrap.md
  which owns the full security/consent posture together with the rendered
  ACCESS_POLICY.md; zero plan IDs / review-round references.
- [C7] Public product names ("GBrain for Codex"/"GBrain for Claude Code") are a
  pre-merge checklist item owned by Garry (trademark review); all committed copy uses
  the neutral `gbrain bootstrap` verb until sign-off.
- [C8] Zero-migration release confirmed (facts/context_volunteer_events already
  exist); ALL new bootstrap telemetry stays on the filesystem — the moment it moves
  into a table it becomes migration v126 + bootstrap-coverage + engine-parity
  obligations.
- [G16] User-scope consent question names the project-scope tradeoff explicitly;
  CLAUDE.md renders a one-line "this agent lives in <dir>" note.

## Outside-voice absorption (Codex, 2026-08-07 — dispositions under Garry's
## auto-accept directive; CX ids trace to the codex output)

**ACCEPTED — product-critical (the two the whole review chain missed):**
- [CX-P0.5 **Keyless mode is a first-class design requirement.**] The named pilot user
  has ChatGPT Pro but NO API keys — and gbrain's embeddings + extract_facts (Haiku)
  are API-metered. Bootstrap MUST work with zero API keys: the HARNESS AGENT is the
  subsidized LLM, so AGENTS.md instructs it to author facts/timeline/links explicitly
  through write ops (zero API cost); search degrades to BM25 keyword (no embeddings);
  verify prints an honest capability report ("keyless mode: keyword search, agent-
  authored memory; add ONE key to unlock embeddings + auto-extraction") and the
  interview offers the optional key question. The magic-moment check must pass in
  keyless mode (fact written by the agent via ops, recalled next session). Quota-gate
  copy amended: API spend (embeddings/extraction) is metered separately from
  subscription quota and is ZERO in keyless mode; with a key, existing spend gates
  (docs/operations/spend-controls.md) govern. [also resolves CX-P0.6]
- [CX-P0.1+P0.3 **Serve-resident maintenance sweep** closes the persistence loop.]
  Nothing previously ingested the transcript corpus into the live brain (dream is
  disabled; CLI can't open PGLite under a live serve), and remote `put_page`
  deliberately skips auto-link/timeline extraction (operations.ts:1273) so the graph
  would never compound from harness writes. Fix: the serve process (the lock owner)
  runs a bounded, spend-gated maintenance sweep — on startup and idle — that (a)
  ingests unprocessed corpus files (keyless mode: skipped, agent-authored memory
  covers it), (b) runs the deterministic zero-LLM link/timeline extraction over
  recently written workspace-source pages. Verify's graph-floor check exercises the
  REAL MCP write path end-to-end (write via stdio op → sweep → edge query), never a
  synthetic install-time shim.

**ACCEPTED — durability/trust:**
- [CX-P0.4] Write-through failures on `put_page` are best-effort today → for the
  workspace source they become LOUD: doctor check counts DB-pages lacking file
  backing; surfaced in the SessionStart digest; sources push reconciles before commit.
- [CX-P1.1] Single-principal visibility posture: bootstrap sets the workspace brain's
  fact default visibility to 'world' (the desktop agent IS the principal's main
  session; ACCESS_POLICY.md documents it; multi-tier users flip the knob). Keeps the
  IPC world-only filter (S3#1) AND working personalization.
- [CX-P1.2] The injected turn_context block is wrapped in the same "retrieved data,
  never instructions" subordinate envelope as interview answers (provenance-labeled).
- [CX-P1.4] GUI env inheritance: MCP registration carries the absolute binary path +
  explicit env (GBRAIN_SOURCE, GBRAIN_HOME when --isolated); provider keys resolve
  from ~/.gbrain/config.json, never from shell env, for GUI-spawned serves.
- [CX-P1.5] **`bootstrap attach` mode** (machine two): a cloned repo carrying
  agent.json enters attach mode (register source, hooks --repair, MCP, verify) —
  the refuse-pre-existing-origin rule (G8) applies only when agent.json is absent.
- [CX-P1.6] Git conflict model: sources push does fetch + divergence-safe rebase pull
  (reuse harden's divergenceSafePull) before push; non-FF/conflict = loud status +
  agent-relayed instruction, never silent retry; repo-local git author identity set
  at `bootstrap repo` (ported from setup-private-repo).
- [CX-P1.7] Search-mode consent folds into the interview as one optional question
  (default balanced) — preserves the INSTALL_FOR_AGENTS consent contract without
  another stop; the spike's TTFM measurement counts every stop.
- [CX-P1.9] Non-circular error surface: README + GITHUB.md carry the one recovery
  command ("if it seems broken: `gbrain doctor`"); doctor covers hook/push/serve
  health independent of the possibly-broken agent loop.
- [CX-P1.10] Forget semantics documented honestly in ACCESS_POLICY.md/GITHUB.md: the
  repo is append-only history; true deletion = documented history-rewrite procedure;
  GitHub remains default-but-optional (local-only mode with honest warning).
- [CX-P1.11] Template repo README embeds the same VERSION stamp as the runbook;
  `bootstrap status` validates it identically (closes the adopter-skew window).
- [CX-P1.12] agent.json spec labeled **provisional-v1**: desktop-side validation
  only, consumers tolerate unknown fields, hosted mount may bump to v2 with a
  migration note — a version contract, not a frozen promise.
- [CX-P0.7+P1.13] Spike/pilot instrument upgraded from binary pass/fail to product
  metrics: per-turn write-attempt vs durable-write precision, correct-recall rate,
  false-memory incidents, correction round-trips — measured through the 2-week pilot
  (the pilot IS the extended sample); the 0-failures-in-20 bar remains only the
  minimum to START the pilot.

**REJECTED (with reasons, recorded):**
- [CX-P0.2] "Two desktop apps cannot share the brain" — TRUE for simultaneous
  sessions and already the documented v1 limit (polite collision + doctor + attach
  proxy fast-follow); sequential use works. No change beyond what's accepted.
- [CX-P1.8] "Networked paste flow untested" — known; manual clean-machine acceptance
  in v1 + networked Docker e2e deliberately deferred (D3.3b). Stands.

**CROSS-MODEL TENSION (recorded, not re-litigated):** Codex's "fundamental
simplification" (Codex-only, 3-question interview, no hooks/template/GitHub, 2-week
manual pilot before building) is a REDUCTION-mode argument against the settled
cathedral decision (D1-A) and accepted Approach B scope. Disposition: rejected as
sequencing (Garry chose the cathedral 30 minutes prior, with the two-wave case
recorded for revisit + a size trip-wire), but its measurement substance was absorbed
via CX-P0.7/P1.13, and the spike + pilot ARE the "prove the loop" instrument, run
before the doors ship rather than instead of building them.


## Design (synthesized)

Synthesis of three independent designs (DX lens, runtime-parity lens, architecture lens) +
an adversarial critique that verified the load-bearing claims against both repos. Where the
designs disagreed, the critique's evidence-checked winner is taken.

### The experience (end state)

One paste block (README + tweet) → the agent fetches `BOOTSTRAP_FOR_AGENTS.md` (raw GitHub
URL **pinned to a release tag**, same mechanism as INSTALL_FOR_AGENTS.md) and drives:

preflight → interview (chat, 12Q/6-required, hard gate) → render identity files → skills →
MCP + hooks wiring → sources add/sync/embed → private GitHub repo (created, privacy-verified,
pushed) → `gbrain bootstrap verify` (exit-code contract) → completion manifest.

Human actions: paste, answer interview in chat, `gh auth login` if needed, ~2 consent
questions. Target ≤15 min. Definition of done includes the magic moment: after restart, the
agent recalls a fact the human said during the interview.

Second session: SessionStart hook injects identity digest + "since last time"; every prompt
gets Live Context + ≤3 volunteered brain pointers + hot memory injected via hook; the agent
writes facts back same-turn through MCP ops; SessionEnd ingests the transcript into the dream
corpus and fires a scan-gated commit+push. "Your local harness IS your agent."

### Decisions (settled by panel + critique)

- **D1 Topology: single private repo.** Workspace root = identity files (SOUL.md, USER.md,
  MEMORY.md, AGENTS.md, CLAUDE.md, HEARTBEAT.md, GITHUB.md, ACCESS_POLICY.md) + `skills/` +
  `memory/` (daily notes + README) + `state/` + **`brain/`** (people/ companies/ meetings/
  concepts/ daily/). **Only `brain/` is registered as the gbrain source** (critique: indexing
  the whole repo puts the contract files into the retrieval corpus — noise + self-referential
  injection surface). `.gbrain-source` dotfile at root routes CLI calls. PGLite DB is NEVER
  in the repo (`.gitignore` renders first: `*.pglite`, `.env*`, `state/*.local`, corpus paths,
  keys/PEM). Two-repo model stays documented as the graduation path in GITHUB.md/docs.
- **D2 Workspace = the cwd the user pasted in.** Guard: if cwd is an existing code project
  (tracked files/remote), ask ONE relocation question. DB default: global `~/.gbrain` host
  brain (workspace is a source); `--isolated` escape hatch per resolved D2.
- **D3 Delivery: hybrid.** New `gbrain bootstrap` command family (deterministic, idempotent,
  exit-coded) + fetched runbook (judgment: interview wording, read-backs, consent). Bootstrap
  is **CLI-only like init/connect — NOT an operation**; zero new `ctx.remote` surface (a
  remote-triggerable `gh repo create` + filesystem render is forbidden by the trust model).
  Subcommands: `status` (resume entrypoint; also verifies runbook version stamp vs binary —
  supply-chain skew check), `interview --init|--set K V|--skip K|--status|--confirm|--show`,
  `render [--force] [--only F] [--minimal]`, `repo`, `hooks --harness claude-code|codex
  [--repair]`, `verify [--json]`.
- **D4 Interview: one question bank, two entry points.** Port codex-as-agent's
  `questions.json` (scrubbed) to `templates/bootstrap/questions.json`: 12 asked / 6 required
  (AGENT_NAME, PRINCIPAL_NAME, AGENT_PURPOSE, AGENT_TOP_JOBS, PRINCIPAL_CONTEXT,
  VOICE_REGISTER — the wince question and vibe samples from soul-audit Phase 2 fold in as
  optional keys). Answers → `<ws>/state/interview.json` (committed; identity source of truth,
  same sensitivity as the rendered USER.md; makes re-render-on-new-machine work).
  `--status` exits non-zero until required present; `render` additionally refuses until
  `--confirm` (set only after the read-back "Is this the thing you want in the room?").
  Hard rules verbatim in runbook: NEVER INVENT ANSWERS, accept "skip", quote literal words.
  `skills/soul-audit/SKILL.md` becomes the re-run/deepen surface over the same bank
  (`interview --set` + `render --only SOUL.md`) — one bank, CI-guarded against drift.
- **D5 Per-turn context (critique-decided; the PGLite lock is the constraint).**
  `gbrain serve` holds the PGLite single-writer lock for its lifetime (#2348: live holders
  are never stolen) — so hooks must NEVER open the engine on PGLite. New engine-free
  `gbrain hook <event>` command (no-engine dispatch branch in cli.ts) talks ONLY to serve's
  existing resolve-IPC unix socket (`src/core/context/resolve-ipc.ts`), widened with
  back-compat `kind: 'resolve' | 'turn_context'`. `turn_context` request carries
  {window, priorContextText, sourceId}; serve assembles server-side (new
  `src/core/context/turn-context.ts`): reflex pointers + volunteerContext pages (≤3) +
  hot-memory facts (the same content `_meta.brain_hot_memory` carries — this ROUTES AROUND
  the _meta invisibility rather than fixing the harness). Postgres fallback: hook opens the
  engine directly (multi-connection safe) since the IPC socket only exists on PGLite.
  - Claude Code hooks (written to **`.claude/settings.local.json`** — gitignored; committed
    hooks with absolute paths are a portability trap + persistence-of-execution surface;
    `bootstrap hooks --repair` re-renders on a new machine):
    - SessionStart → `gbrain hook session-start`: zero-DB file reads (date/tz, MEMORY.md
      open-commitments, ops/tasks.md if present) + best-effort socket warm probe. ≤1.5s.
    - UserPromptSubmit → `gbrain hook user-prompt`: stdin hook JSON → tail last 4 turns from
      transcript_path → socket turn_context → stdout additionalContext block.
      **800ms hard self-deadline**, fail-open (exit 0, empty stdout), heartbeat JSONL at
      `~/.gbrain/integrations/hooks/` for doctor.
    - Stop → `gbrain hook stop`: append turn to live per-session buffer (pure file append).
    - SessionEnd → `gbrain hook session-end`: parse full transcript .jsonl → corpus .txt in
      `dream.synthesize.session_corpus_dir` (default `~/.gbrain/transcripts/corpus/`, 0700,
      never in the repo) + fire scan-gated commit+push (D6). Closes the transcript gap in PR1.
    - Absolute binary path everywhere; `GBRAIN_HOOKS=0` kill switch.
  - Codex (no hooks): honest pull model. Rendered AGENTS.md carries adapted per-message
    gates 0–7 (entity lookup = "call recall/volunteer_context with recent window";
    receipts; WRITE IT DOWN same turn via extract_facts/put_page) +
    `codex mcp add gbrain -- gbrain serve`. FF2: `notify` hook in ~/.codex/config.toml as
    transcript sweeper (validate the event semantics first). Runbook/verify state the
    degradation plainly: Claude Code = push-on-hook, Codex = pull-on-protocol.
  - **Write-path rule rendered into AGENTS.md** (critique hole 2): on PGLite, durable
    knowledge is written through MCP ops (put_page/extract_facts/add_timeline_entry), never
    by editing brain/ files directly — file edits are invisible to retrieval until a sync
    can run, and sync can't run while serve holds the lock. MEMORY.md/memory/ file edits are
    fine (file-plane, loaded by path not retrieval).
- **D6 Private repo + persistence.** `gbrain bootstrap repo` = TS port of
  setup-private-repo.mjs: gh-auth exit-2 gate (only human step: `gh auth login`), slugified
  `<agent-name>-workspace` collision probe, `gh repo create --private --source . --push`,
  **privacy verified via `gh api ... --jq .private` (hard fail)**. Sync: extract secret scan
  to `src/core/secret-scan.ts` (sk-/gh[pousr]_/github_pat_/xox[baprs]-/PEM; blocks commit);
  new `gbrain sources push [<id>|--path]` = scan-gated add+commit+push, refuses public
  remotes, pushes even on clean tree. `hardenBrainRepo` gains the scan as a step (its
  existing post-commit hook + cron machinery is reused, NOT a parallel sync system).
  Cadence per resolved D3: 15-min cron installed after an explicit consent question;
  SessionEnd-hook push always on as the no-daemon backstop/fallback. GITHUB.md persistence
  contract rendered.
- **D7 Rendered files.** AGENTS.md (adapted gates + hard gates: WRITE IT DOWN, NO SILENT
  FAILURE, VERIFY BEFORE CLAIMING DONE, RED LINES, PRIVATE REPO PERSISTENCE + brain-first
  protocol from docs/tutorials/connect-coding-agent.md + brain filing contract rendered from
  skills/_brain-filing-rules.md), CLAUDE.md (thin: @AGENTS.md @SOUL.md @USER.md @MEMORY.md +
  hooks note), SOUL.md (codex-as-agent section skeleton: Identity/Mission/Worldview/The
  Standard/Honesty/Voice+wince/Good vs bad output/High agency/Never — IDENTITY.md merged in),
  USER.md ("their literal words are ground truth"), **MEMORY.md (new template**: hot state,
  corrections format `- YYYY-MM-DD — rule (Bug: ...)`, open commitments, security-boundary
  note), ACCESS_POLICY.md, HEARTBEAT.md (quiet hours, verify-time-first, silence contract,
  jobs disabled), GITHUB.md, memory/README.md, brain/ dirs + READMEs, .gitignore,
  state/interview.json, state/mcp.json (portable snippet). Skills via existing
  `gbrain skillpack scaffold --all` (resolved D4) + inert-skill report (skillpack check
  wired into verify AND into the completion manifest's next-steps block with the exact API
  keys to add). ALL templates REWRITTEN generic (privacy IRON RULE —
  never copy codex-as-agent prose verbatim; CI placeholder assertion). TOOLS.md deferred
  (essential lines fold into AGENTS.md). `installDefaultTemplates` (init.ts:1513) finally
  gets its caller via `render --minimal`.
- **D8 Verify (union).** (1) doctor green; (2) DB round-trip: put_page → get → query-with-
  score → DELETE probe page; (3) MCP registered (`claude|codex mcp list`) + probeBrainIdentity
  smoke; (4) {{TOKEN}} sweep hard-fail; (5) byte floors (SOUL.md ≥3000B, USER.md ≥1000B);
  (6) secret scan clean; (7) repo private via API; (8) **hooks smoke UNDER LIVE SERVE**
  (spawn real serve, pipe fixture UserPromptSubmit stdin, assert non-empty block + <800ms +
  never acquires the lock — bootstrap-time-only smoke is a false green); (9) one manual
  sources push succeeded; (10) inert-skill report; (11) transcript parser dry-run on fixture.
  Prints ranked completion manifest. Re-runnable weekly as the workspace rot self-check.
- **D9 Scheduling: almost nothing on by default.** ON: SessionEnd push (event-driven, no
  daemon). OPT-IN: 15-min harden cron. Autopilot NOT default on PGLite (verified: its
  sync/embed children would contend with every live serve for the single-writer lock, and
  nothing handles LiveServeLockError politely today) — recommended on Postgres; any future
  scheduled job must treat lock-held as skip-silently-and-log. LLM crons (briefing, dream via
  `claude -p`/`codex exec`) ship rendered-but-disabled with the enable-one-at-a-time ritual.
- **D10 Phasing.**
  - **PR1 (complete usable experience):** BOOTSTRAP_FOR_AGENTS.md + README paste block;
    `gbrain bootstrap` family; `gbrain hook` + IPC v2 turn_context; new templates + question
    bank; secret-scan + `sources push` + harden integration; SessionEnd transcript ingest
    (Claude Code .jsonl parser); skillpack scaffold wiring; soul-audit re-run update; doctor
    checks (hooks heartbeat, dual-serve report, sync check); docs; unit + e2e (incl.
    hook-under-serve + lock-contention pins); CI guards.
  - **FF2:** Codex notify sweeper + ~/.codex/sessions parser. **FF3:** `gbrain serve
    --attach` stdio proxy (two harnesses fully concurrent on one PGLite brain). **FF4:**
    cron fleet + cron-doctor port + heartbeat activation. **FF5:** Docker fresh-machine e2e
    in CI, _meta surfacing experiments, per-turn-context BrainBench eval, upgrade re-render
    nudge via runPostUpgrade (`bootstrap render --diff`).

### Security/trust invariants (critique holes, addressed)

1. Paste block pinned to release tag; runbook version-stamped; `bootstrap status` compares
   stamp vs binary and warns; runbook instructs refusing steps outside its phase list.
2. Write-through-ops rule in AGENTS.md (above).
3. MCP scope: project scope default, user-scope opt-in (resolved D1); threat named in
   ACCESS_POLICY.md either way.
4. Codex sandbox reality: runbook carries a Codex-specific preflight (approval mode /
   workspace-write + network consent) — the paste block warns the human they'll be asked.
5. Hooks in settings.local.json (gitignored) + --repair.
6. Upgrade story: FF5 re-render nudge; render never clobbers (backup on --force).
7. Transcript corpus + answers privacy: corpus 0700 outside repo; interview.json committed
   (same sensitivity as rendered USER.md, which is committed); responsible-disclosure
   phrasing in CHANGELOG (functional, no attack-surface enumeration).
8. Process invariants: CLAUDE.md dispatcher row edit → `bun run build:llms` same commit;
   KEY_FILES.md entries current-state prose; version-first PR title; ship via /ship;
   /document-release after.

### New/changed artifacts (paths)

| Path | New/changed |
|---|---|
| `BOOTSTRAP_FOR_AGENTS.md` | NEW root runbook (fetched by paste block) |
| `README.md` | dedicated "For Codex" / "For Claude Code" paste-block sections, ordered Codex → Claude Code → OpenClaw/Hermes at equal weight (user decision 2026-08-09, supersedes D5's ordering; both platform paths preserved) |
| `src/commands/bootstrap.ts` (+ `src/commands/bootstrap/*.ts`) | NEW dispatcher + subcommands |
| `src/commands/hook.ts` | NEW `gbrain hook session-start|user-prompt|stop|session-end` |
| `src/cli.ts` | CHANGED: `bootstrap`+`hook` in no-engine dispatch branch |
| `src/core/bootstrap/{interview,render,private-repo,verify}.ts` | NEW (TS ports) |
| `src/core/secret-scan.ts` | NEW (shared: sources push, harden, verify) |
| `src/commands/sources.ts` + `src/core/brain-repo-durability.ts` | CHANGED: `sources push`, scan-gated hook/cron |
| `src/core/context/resolve-ipc.ts` + `src/mcp/server.ts` | CHANGED: IPC v2 `turn_context` (back-compat) |
| `src/core/context/turn-context.ts` | NEW server-side block assembly |
| `src/core/transcripts/claude-code-jsonl.ts` | NEW parser + corpus writer |
| `templates/{MEMORY,AGENTS,CLAUDE,GITHUB,memory-README}.md.template` + `gitignore.template` + enriched SOUL/USER/HEARTBEAT/ACCESS_POLICY | NEW/CHANGED (generic, scrubbed) |
| `templates/bootstrap/questions.json` | NEW shared question bank |
| `skills/soul-audit/SKILL.md` | CHANGED: re-run surface over the bank |
| `src/commands/doctor.ts` | CHANGED: hooks heartbeat, dual-serve, sync checks |
| `docs/guides/bootstrap.md` + docs/mcp/ + connect-coding-agent.md cross-links | NEW/CHANGED |
| `scripts/check-bootstrap-templates.sh` | NEW CI guard (token↔bank bijection + placeholder-only assertion) |
| `docs/architecture/KEY_FILES.md`, `CLAUDE.md` (+build:llms) | CHANGED |
| `test/bootstrap-*.test.ts`, `test/hook-command.test.ts`, `test/secret-scan.test.ts`, `test/e2e/bootstrap-lifecycle.test.ts`, IPC back-compat tests | NEW |

### Port map (codex-as-agent → gbrain)

interview.mjs → core/bootstrap/interview.ts · render-templates.mjs → core/bootstrap/render.ts
· setup-private-repo.mjs → core/bootstrap/private-repo.ts · verify-install.mjs (+
install-gbrain.mjs round-trip) → core/bootstrap/verify.ts · git-sync.mjs → secret-scan.ts +
sources push · questions.json → templates/bootstrap/questions.json (scrubbed) · AGENTS.md
gates 0–7 / SOUL/USER/MEMORY/HEARTBEAT/GITHUB templates → REFERENCE structure, REWRITE
content (privacy rule) · install-skills.mjs → REFERENCE (skillpack scaffold exists) ·
cron fleet/cron-doctor → FF4 · codex-plugin-spec one-file-owns-format pattern → governs the
settings.local.json + config.toml writers (single module owns each host format).

### Verification (how we know it works end-to-end)

- Unit: interview gate exit codes; render token hard-fail/no-clobber/backup; secret-scan
  fixture corpus (positives + benign lookalikes); hook stdin→JSON contract; IPC v1↔v2
  back-compat both directions; questions.json↔template token bijection.
- E2E: full lifecycle in temp dir (sandboxed GBRAIN_HOME, PATH-shimmed fake gh/claude/codex
  recording invocations): render → repo → verify exit 0; idempotency (second run no-op);
  kill-mid-phase → `status` resumes. **hook-under-serve** and **lock-contention** pins
  (permanent). Engine parity for turn-context on both engines.
- Manual acceptance at ship: fresh macOS account, real paste, both harnesses, timed
  (≤15 min, ≤3 human actions).

### Resolved user decisions (Garry, 2026-08-07)

- **D1 = A. MCP scope: project scope default, user-scope opt-in** (consent question during
  bootstrap; threat named in ACCESS_POLICY.md).
- **D2 = C. DB: global `~/.gbrain` default + documented `--isolated` escape hatch.**
  `gbrain bootstrap --isolated` threads `GBRAIN_HOME=<workspace>/.gbrain` through init, MCP
  registration env (`claude mcp add -e` / codex config env), and the hook commands in
  settings.local.json. Port install-gbrain.mjs's guards: GBRAIN_HOME does NOT isolate
  `sync.repo_path` (set it explicitly), strip ambient GBRAIN_DATABASE_URL/DATABASE_URL/
  GBRAIN_BRAIN_ID, assert database_path is inside the workspace. `.gbrain/` already
  gitignored by the rendered template.
- **D3 = B with consent. 15-min scan-gated commit+push cron is the default posture, but the
  runbook ASKS PERMISSION before installing it** ("Enable background persistence? Installs a
  15-min launchd/cron job that commits + pushes this workspace, secret-scan-gated"). The
  SessionEnd-hook push stays as the always-available, no-daemon backstop and is the fallback
  when the cron is declined — persistence never silently disappears. Autopilot posture
  unchanged: off on PGLite, recommended on Postgres.
- **D4 = B. ALL bundled skills scaffold in** (`skillpack scaffold --all`). The onboarding
  ENDS with a next-steps block in the completion manifest: the inert-skill report (which
  installed skills are dormant for lack of which API key), the exact keys to add and where,
  and pointers to soul-audit (deepen identity this week) + cold-start (fill the brain with
  your data). The routing-table-size concern is mitigated by frontmatter-trigger routing
  (authoritative since v0.36) and noted for a future curated-profile fast-follow if dispatch
  accuracy suffers in practice.
- **D5 = Codex/Claude-Code-scoped placement.** [Superseded by the 2026-08-09 user
  decision — see as-shipped delta 6 and the artifact table's README row.] This is NOT the new headline install —
  most users still use GBrain with OpenClaw/Hermes, so `INSTALL_FOR_AGENTS.md` remains the
  primary paste path at the top of the README. The bootstrap paste block becomes the
  flagship "For Codex" / "For Claude Code" README sections, ahead of the OpenClaw/Hermes path at equal weight (and
  docs/tutorials/connect-coding-agent.md cross-links it). Command name stays
  `gbrain bootstrap`; paste block is pinned to a release tag (supply-chain integrity).
  BOOTSTRAP_FOR_AGENTS.md opens with a scope note: "For Claude Code / Codex. Running
  OpenClaw or Hermes? Use INSTALL_FOR_AGENTS.md instead."

