# Ambient memory writeback

Ambient recall ([ambient-recall.md](./ambient-recall.md)) is the READ side of
memory: context arrives at session boundaries without a question being asked.
This guide is the WRITE side: when the brain's operator opts in, agents save
salient facts the user states directly — during ordinary conversation, without
being told to — through the existing MEMORY_VERBS surface. No new protocol
verb; `remember` and `extract_facts` do all the writing.

**Say to your agent:** *"Turn on ambient memory writeback for my brain"* —
*"remember things I tell you without being asked"* — your agent runs
`gbrain config set memory.auto_writeback salient` and
`gbrain bootstrap harness --yes`.

Off by default. Nothing in this feature ever enables itself.

## Who gets asked (and who is never asked)

gbrain distinguishes PERSONAL brains from company/team brains and only ever
*offers* ambient writeback on personal ones — capturing what people say to
agents on a shared brain is a privacy decision the whole team owns, not a
default.

- **Declaration wins.** `brain.audience` (`personal` | `shared`) is the
  declared axis: set it yourself, let `company-brainify` stamp `shared` at its
  Phase-5 handoff, or answer the bootstrap interview. A declaration always
  beats the heuristic.
- **The heuristic is conservative.** Without a declaration, only ≥3 distinct
  non-automation MCP clients active in the last 30 days reads as shared
  evidence (client count measures surface breadth, not people — Claude Code +
  Codex + a phone client is one human). `gbrain doctor`'s `memory_writeback`
  check shows the resolved audience and its reasons; correct a
  misclassification with `gbrain config set brain.audience personal|shared`.
- **The ask fires once.** On personal brains, `gbrain init` and the
  post-upgrade banner print a one-time `[AGENT]`-relayed disclosure + ask
  (sentinel `memory.auto_writeback_notice_shown`); declining is permanent.
  `gbrain advisor` keeps a quiet reminder afterward — informational only,
  never `--apply`-able: consent is never automated.
- **Silence everywhere else:** shared/unknown brains, mounted team brains,
  thin clients, remote MCP callers, and any classifier failure.
- Explicitly enabling on a shared-classified brain works (operator
  sovereignty) but prints a caution: members' words get persisted into a
  store other authorized agents can read.

## Modes

| `memory.auto_writeback` | What agents are told to save |
|---|---|
| `off` (default) | Nothing — no instruction section, no backstop, no banking. |
| `salient` (recommended) | Durable, notable claims only: preferences, corrections, decisions, commitments, relationships, project-state changes. The backstop keeps medium+ notability facts. |
| `all` | Every direct factual user statement — still excluding operational chatter, assistant-generated content, secrets/credentials, and quoted third-party material. Precision rides the extractor's semantic skip rules (the second of the two filters); expect more low-value facts and more extraction spend. |

Both planes carry the setting: `gbrain config set memory.auto_writeback …`
dual-writes the DB plane (authoritative — the serve re-checks it before any
extraction) and the `~/.gbrain/config.json` mirror (what the engine-free
Stop-hook child reads). The mirror never *enables* anything on its own: it is
machine-global while DB rows are per-brain, so engine-backed resolution is
DB-only — a mounted or selected brain whose operator never opted in cannot
inherit another brain's setting. When the planes disagree (a failed
dual-write, a reinitialized DB, or a `config set` run on another machine of a
shared Postgres brain), that is **plane drift**: extraction gates hold banked
turns without the terminal skip (nothing is destroyed), `gbrain doctor` warns
with the one-line re-sync (`gbrain config set memory.auto_writeback <mode>`),
and a DB-write failure during `config set` itself exits non-zero and says the
runtime value is unchanged. Selecting a MOUNTED brain (`--brain`,
`GBRAIN_BRAIN_ID`, `.gbrain-mount`) writes the mount's DB row only — the
machine-local mirror gates the host's Stop hook, so enabling a team mount
never opts the host's own conversations into banking. A wrong-brain hook
bank remains harmless — the target serve's own DB gate decides.

## The three activation surfaces

1. **MCP `instructions` (all transports).** When enabled, the initialize
   handshake appends a ~15-line ambient-writeback contract to the base
   operating contract — one claim per `remember` call, `entity` whenever a
   person/company/project is the subject, concise provenance (harness +
   session id + date), durable facts without `ttl`, transient facts with the
   configured TTL, the skip-list, and the visibility rule. stdio resolves it
   at boot (restart to flip — same posture as `mcp.strict_params`); the HTTP
   transports resolve per request (restart-free, with a last-known-good
   bundle riding out config blips). The section only renders when the
   caller can actually invoke `remember` — OAuth tokens without write scope,
   slug-bound clients whose fence denies it, and clamped surfaces that drop
   it all get the base instructions instead (never orders to make calls
   dispatch will deny); `extract_facts` is only named when the transport's
   actual tool set can call it.
2. **Managed harness instruction blocks.** `gbrain bootstrap harness --yes`
   installs the same contract (same builder — the surfaces cannot drift) as a
   managed block between `<!-- gbrain:ambient-writeback:begin/end -->`
   sentinels in user-scope `CLAUDE.md` (Claude Code) and `$CODEX_HOME/AGENTS.md`
   (Codex). Idempotent re-runs; converge-on-off (re-running with writeback off
   removes the block); `--remove` strips it. Codex caveat: when
   `$CODEX_HOME/AGENTS.override.md` exists, Codex ignores `AGENTS.md` entirely
   — bootstrap fails that target loudly and doctor warns, instead of reporting
   a dead integration as healthy. The block header names the serve endpoint;
   after changing mode/TTL/visibility config, re-run
   `gbrain config set memory.auto_writeback <mode>` then `bootstrap harness`
   (the config set refreshes the engine-free posture stamp the renderer
   reads; doctor's drift warning names the same combo). Blocks install only
   after the same run's MCP registration confirms, and a failed final smoke
   test strips the blocks that run installed — no block outlives a
   rolled-back registration. Registrar mode
   (`--url` to a non-loopback serve) never installs instruction blocks: the
   local setting speaks for the local brain, and the remote brain's own MCP
   instructions carry the contract when *its* operator enables writeback.
3. **The Claude Code Stop-hook backstop.** After each assistant turn, the
   hook gates the user's message through a deterministic, zero-LLM filter
   (min length — CJK-aware, pasted blocks removed, ack/greeting lexicon,
   slash commands, question-only turns, quoted/tool output, bulk pastes
   >8KB; see "Pasted content" below), secret-scans
   it, banks it as a content-addressed `.wb-` corpus file (same turn = same
   name = free dedup, even on keyless brains), and asks the serve to extract
   it asynchronously. The hook never blocks: its own 2s deadline inside
   Stop's 10s cap, exit 0 on every path, typed heartbeat reasons for every
   outcome. Serve down? The file waits for the maintenance sweep. The lane is
   engine-uniform: the IPC listener keys its socket off the brain's
   connection URL, so Postgres brains harvest the same way whenever a
   `gbrain serve` for that brain is running (heartbeat `no_serve` between
   serves — the banked file is the durable artifact either way).

   When the brain's canonical writer stays busy past the extraction
   preflight's own wait (a Git commit or push holds the writer lock for a few
   seconds), the serve re-queues the turn up to three times, 5, 15 and 45
   seconds apart (heartbeat `writer_busy_requeued`), before any model call.
   A turn that still fails ends with the error name and code as its reason
   (for example `operationerror:writer_lock_unavailable`), the serve's
   stderr names the first failure of each reason, and `gbrain doctor` warns
   in `memory_writeback` when at least 10 harvests finished in the last 7
   days and more than 20% of them failed. A failed turn keeps its file and
   waits for a corpus sweep.

   **A failed turn is swept on its own.** `gbrain serve --http` runs a
   corpus drain every 10 minutes while any corpus file is still unextracted
   (a sweep with a 60-second budget), and a stdio serve sweeps at startup
   and after 10 minutes idle. A sweep's budget stops it between files, never
   mid-extraction, so a slow model (`claude-cli` often takes 8 to 25 seconds
   per turn) still finishes the file it started. Turns the serve could not
   extract (failed, over the per-session cap, or banked while the serve was
   down) are picked up by the next drain or sweep. To clear a backlog
   sooner, run `gbrain sweep --once --budget-ms 600000` on the brain host.
   A corpus file nothing has extracted is kept for three times
   `dream.synthesize.corpus_retention_days` (90 days by default), and
   `gbrain doctor` warns in `memory_writeback` once one is past plain
   retention. `GBRAIN_SWEEP=0` turns every serve sweep and drain off.

   **Say to your agent:** *"Make sure the turns my brain could not extract
   are swept."* (the agent runs `gbrain sweep --once --budget-ms 600000` on
   the brain host) or *"Why are my writeback harvests
   failing?"* (the agent reads `gbrain doctor` `memory_writeback` and the
   `writeback` heartbeat reasons).

   Sessions run by gbrain's own `claude-cli` model provider are never
   banked (heartbeat reason `self_capture`): extracting gbrain's internal
   LLM calls as your conversations would spawn another call that banks
   again. The provider also starts its `claude` child with your Claude Code
   hooks disabled, and the serve-side harvest and the sweep skip any such
   file an older binary left behind. `gbrain doctor` (`self_capture`) lists
   leftover files with one-time quarantine commands, and
   `captured_facts_active` counts facts already extracted from such sessions;
   `gbrain repair captured-facts` previews and expires them
   ([repair guide](repair.md#captured-facts)).

## Pasted content

When you paste a block into Claude Code, the transcript records it inside
`<pasted_content id="…">…</pasted_content id="…">` tags. Pasted text is
usually someone else's words (an email, an article, a log), so it is never
captured as a fact about you.

- **Capture.** The Stop hook removes pasted blocks before any rule runs and
  banks only your own words from the turn. A turn that was only a paste banks
  nothing (heartbeat reason `pasted_content`). Every fact-extraction pass that
  reads session transcripts (the serve-side harvest, the maintenance sweep and
  the dream `extract_atoms` phase) removes pastes from each of your turns
  before the extractor sees the text. An assistant reply that restates a
  pasted claim is still ordinary assistant text and can still be extracted.
- **Retention.** Nothing is deleted. Transcripts, the session corpus files,
  `gbrain transcripts ingest`, ambient recall and the dream `synthesize`
  phase (which writes idea pages, not facts about you) still see the pasted
  text with its tags.
- **Repair.** Facts extracted from pastes by releases before v0.60.30.0 stay
  active until removed. `gbrain repair captured-facts --include-ambiguous`
  lists likely paste-derived facts (a word-overlap heuristic against the
  retained session corpus) and expires the previewed set only with
  `--apply --expect <hash>` ([repair guide](repair.md#captured-facts)). For a
  single fact, find it with `gbrain recall` and withdraw it with
  `gbrain forget <fact-id> --reason "came from a pasted email"`.

To keep something you pasted, save it explicitly with its provenance:

```bash
gbrain remember "The team offsite moves to March; the budget is final" \
  --entity projects/offsite-example --provenance "pasted email from a colleague, 2026-10-01"
gbrain recall projects/offsite-example
```

Or ask your agent: *"Remember the offsite date from the email I just pasted,
and note that it came from that email."*

## Proving an extraction ran

`extract_facts` has no caller-defined binding field such as a `job_binding`
(#5278). On a managed brain the attestation is the durable write receipt:
pass your own `request_id` (a UUID you can record against your job), and the
response carries a `write_request` receipt for it; `get_write_request` with
the same `request_id` reads it back later, including after a timeout. A brain
that is not managed runs extraction without a journal, so there is no receipt
to bind to.

## Duplicates across lanes

The same claim can arrive twice: the agent saves it with `remember`, and the
writeback, compaction harvest or maintenance sweep extracts it again from the
same turn. Automatic capture skips a fact when an active fact in the same
source already has the same normalized text, and

- it is on the same entity (or neither has one), or on a different entity
  whose page title or alias the claim names. "Prefers email" captured for two
  people stays two facts;
- it is visible where the new fact would be. A private capture yields to a
  world-visible `remember`; a world capture never yields to a private fact;
- it was written within 15 minutes of the turn, or by automatic capture in the
  same conversation (no time limit there, so a sweep hours later still
  recognizes the writeback's copy).

Similar but differently worded facts are always kept. Capture counts them as
near duplicates (cosine 0.92 or higher on the same entity, with no difference
in a negation, number or date) so the threshold can be measured before it
ever removes anything. A correction such as "is not moving" or a changed
amount is never treated as a duplicate. If the duplicate check cannot read
the database, the fact is kept and a warning names the lane. Explicit
`remember` is never skipped, so use it for anything that must persist.

Each skip prints `[facts] capture dedup: lane=<lane> dropped a duplicate of
fact #<id> (rule=same_entity|named_entity)` on stderr and adds a
`writeback_dedup` heartbeat event (lane, `duplicate`, `near_duplicate`
counts). `gbrain doctor` shows the 7-day totals as `cross_lane_duplicates_7d`
and `near_duplicates_shadow_7d` under `memory_writeback`. Hot memory and the
`context_pack`/`delta` facts show one line per duplicate group (the newest
row, with every entity in `entity_slugs`).

Two limits remain. Two capture writers racing on the same claim can both
insert it (the check runs outside the write transaction). A `remember` saved
after an automatic copy of the same claim leaves two rows; hot memory shows
them once only when the text is identical, and search can return both.

**Say to your agent:** *"Remember that the renewal moved to November."*
(the agent's `remember` is the copy that stays) or *"How many duplicate facts
did automatic capture skip this week?"* (the agent runs `gbrain doctor --json`
and reads `memory_writeback`).

## Per-harness reality (honest limitations)

| Harness | Real-time contract | Backstop |
|---|---|---|
| Claude Code | MCP instructions + managed user CLAUDE.md block | Stop-hook lane (above) |
| Codex | MCP instructions + managed `$CODEX_HOME/AGENTS.md` block | **No per-turn hook exists** (SessionEnd only, 3s hard-kill). The existing SessionEnd capture → corpus → maintenance-sweep extraction lane is the delayed backstop — whole-session, next-sweep latency, governed by `facts.extraction_enabled` (it predates this feature). |
| opencode / OpenClaw / others | MCP instructions when connected | None wired — follow-ups filed. |

The workspace-bootstrap "same-turn write-back" contract
(`gbrain bootstrap contract`, AGENTS.md) and the two surfaces above are three
renderings of one posture; the MCP section and the harness blocks share one
builder, and the workspace contract is the always-on convention documented in
[bootstrap.md](./bootstrap.md). Keep them coherent when editing any of them.

## TTL: transient facts expire at read time

Agents pass `ttl: "3d"` (configurable: `memory.auto_writeback_transient_ttl`,
duration shorthand only, max `365d`) on transient facts — current health,
location, travel, mood, near-term schedule. Durable facts carry no TTL.

Expiry is **exact-time and read-side**: active reads (`recall`, entity cards,
hot-memory injection, dedup candidates) exclude facts whose `valid_until` has
passed — no sweeper needed, nothing mutated. The rows stay in the database as
history (`--asof` and supersession views still see them), and a re-stated
fact after expiry inserts fresh. Backstop-extracted facts currently get no
TTL (the extractor doesn't classify transience yet — a filed follow-up), so a
transient fact caught only by the backstop is durable until forgotten.

**Note on lapsed rows:** `valid_until` is temporal validity and active reads
honor it, so a brain that already carries lapsed rows sees them leave the
active set on the first read after the migration (facts-health counts step
accordingly). Nothing is deleted or mutated; the doctor's
`validity_lapsed_facts` count sizes the shift.

## Privacy and visibility

- **What is never saved:** greetings, acknowledgements, fact-free questions,
  the assistant's own inferences/diagnoses/speculation, tool output, quoted
  third-party material, pasted/imported text (unless the user explicitly asks;
  see [Pasted content](#pasted-content)), gbrain's own claude-cli calls,
  raw transcripts, and — in every mode — secrets/credentials (banked turns are
  secret-scanned before they touch disk; scanner unavailable = fail-closed
  skip).
- **`world` is not the internet.** Fact visibility `world` means *readable by
  agents authorized on this brain* — the default that makes the
  remember→recall round-trip work across sessions. When
  `facts.default_visibility` is unset, the instruction template tells agents
  to write `world`; only an explicitly-private brain gets the private posture,
  stated with its trade-off: private facts are readable by the local CLI only,
  so remote agents cannot recall them later. `gbrain bootstrap harness` and
  `gbrain doctor` (`memory_writeback`) warn when an explicitly private default
  meets remote readers on a brain not declared `brain.audience=shared`. An explicit private setting is
  never widened — not by the template, not by the backstop (which resolves
  `facts.default_visibility` exactly like `extract_facts` always has).
- Backstop facts carry `source: 'hook:writeback'` and the session's
  `GBRAIN_SOURCE` on BOTH extraction paths: the prompt-time IPC ask carries it
  directly, and the banked filename embeds it (`.src-<sourceId>` segment) so
  the sweep fallback files the turn into the same source even when serve was
  down at Stop time — never the sweep's own source. A conversation spanning
  multiple brains still attributes to the configured one (same limitation as
  the existing capture lanes).

## Cost posture

The instruction path costs nothing extra — the conversing model does the
salience filtering in-line. The backstop runs one extraction call per banked
turn, capped at 30 prompt-harvests per session (overflow degrades to the
sweep's batch pass — freshness lost, nothing dropped within the corpus
retention window; un-ingested files older than the corpus GC's 30-day
retention are deleted, so a keyless brain — or one whose serve AND sweep
stayed away for a month — does eventually shed unbanked turns; serve restarts
reset the counter). Keyless brains skip extraction entirely (typed `keyless` skip)
and still get agent-authored `remember` writes; note that keyless dedup is
degraded (`degraded_dedup`) — near-duplicate phrasings may insert. The
maintenance sweep's corpus pass costs one call per transcript window (see
[Long transcripts](#long-transcripts-windowed-extraction)). See
[spend-controls](../operations/spend-controls.md) for the brain-wide
extraction switches.

### Long transcripts: windowed extraction

**Say to your agent:** *"How much of my long sessions has the sweep
extracted?"* (the agent runs `gbrain sweep --once --json` and reads
`corpus_files[]`) or *"Lower how many transcript windows the sweep extracts at
once."* (the agent sets `GBRAIN_CORPUS_WINDOWS_PER_SWEEP` for the process that
runs the sweep).

The extractor reads at most 8,000 characters per call, so the maintenance
sweep reads a session transcript in windows cut at turn boundaries. Each
window carries its `[user]` or `[assistant]` label, and pasted blocks are
removed before the cut. A long session therefore costs one call per window: a
typical long transcript (about 120 KB) is roughly 15 calls where it used to be
one call that saw only the first 8,000 characters.

Spend per sweep is capped: at most 8 windows per file and 32 windows across all
files. A longer file picks up where it stopped on the next sweep. Progress
is kept in a `<file>.progress` file beside the transcript, so a resumed
session or a compaction rewrite costs only its new turns. The compaction
harvest extracts the first window right away; the sweep does the rest. Set
`GBRAIN_CORPUS_WINDOWS_PER_SWEEP` to a positive integer in the environment of
the process that runs the sweep (`gbrain serve` or `gbrain sweep --once`) to
change the 32-window total; the per-file cap of 8 is fixed. The off switch
for all of this is the brain-wide `facts.extraction_enabled`. `gbrain sweep
--once --json` lists `corpus_files[]` with `windows_done` and
`windows_remaining` per file. Transcripts marked done before windowed
extraction existed are not re-read; only turns added after the upgrade are
extracted, so their tails past the first 8,000 characters stay unextracted.

## Diagnostics

`gbrain doctor` → `memory_writeback`: resolved mode (+`mode_valid`), TTL
(+`ttl_valid`), both visibility postures (instruction template vs backstop),
brain audience + reasons, installed harness blocks (receipt vs live sentinel
probe, override-file detection, config-drift warning — and a receipt target
marked FAILED, e.g. a smoke-rollback strip that itself failed, stays a
standing warn until a `bootstrap harness` re-run or `--remove` converges it),
and validity-lapsed fact count. With writeback OFF the check still probes for
lingering instruction blocks and warns — the off switch is incomplete until a
`bootstrap harness` re-run converges them. It also reports 7-day counters —
`remember` outcomes over MCP (all callers — the
wire cannot distinguish ambient from explicit saves) and persisted backstop
results from the serve-side harvest receipts, plus the capture dedup totals
`cross_lane_duplicates_7d` and `near_duplicates_shadow_7d` (see
[Duplicates across lanes](#duplicates-across-lanes)). Counters are local,
append-only, loss-tolerant observability — never a source of truth.

Two neighbouring checks cover capture residue: `self_capture` counts corpus
files from gbrain's own claude-cli sessions, and `captured_facts_active`
counts facts captured before v0.60.30.0 from those sessions or from pasted
text (cleared by `gbrain repair captured-facts`).

## Enable / verify / disable

```bash
gbrain config set memory.auto_writeback salient
gbrain config set memory.auto_writeback_transient_ttl 3d   # optional; default
gbrain bootstrap harness --harness codex --yes
grep -n "gbrain:ambient-writeback" "${CODEX_HOME:-$HOME/.codex}/AGENTS.md"
gbrain doctor | grep -A6 memory_writeback
# In a NEW agent session, say: "I prefer dark mode in every editor." Then:
gbrain recall --grep "dark mode"
gbrain sweep --once   # drives the sweep backstop extraction immediately
# Off switch (anytime; converge harness blocks with another bootstrap run):
gbrain config set memory.auto_writeback off
gbrain bootstrap harness --yes
```
