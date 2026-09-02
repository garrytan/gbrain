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
   (min length — CJK-aware, ack/greeting lexicon, slash commands,
   question-only turns, quoted/tool output, bulk pastes >8KB), secret-scans
   it, banks it as a content-addressed `.wb-` corpus file (same turn = same
   name = free dedup, even on keyless brains), and asks the serve to extract
   it asynchronously. The hook never blocks: its own 2s deadline inside
   Stop's 10s cap, exit 0 on every path, typed heartbeat reasons for every
   outcome. Serve down? The file waits for the maintenance sweep. The lane is
   engine-uniform: the IPC listener keys its socket off the brain's
   connection URL, so Postgres brains harvest the same way whenever a
   `gbrain serve` for that brain is running (heartbeat `no_serve` between
   serves — the banked file is the durable artifact either way).

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

**Upgrade note (existing brains):** `valid_until` always meant temporal
validity — the consolidator and ontology writers have stamped it for releases
— but active reads only started honoring it with this feature. The first
upgraded read therefore reclassifies every pre-existing lapsed row out of the
active set at once (facts-health counts step accordingly). Nothing is deleted
or mutated; the doctor's `validity_lapsed_facts` count sizes the shift.

## Privacy and visibility

- **What is never saved:** greetings, acknowledgements, fact-free questions,
  the assistant's own inferences/diagnoses/speculation, tool output, quoted
  third-party material, pasted/imported text (unless the user explicitly asks),
  raw transcripts, and — in every mode — secrets/credentials (banked turns are
  secret-scanned before they touch disk; scanner unavailable = fail-closed
  skip).
- **`world` is not the internet.** Fact visibility `world` means *readable by
  agents authorized on this brain* — the default that makes the
  remember→recall round-trip work across sessions. When
  `facts.default_visibility` is unset, the instruction template tells agents
  to write `world`; only an explicitly-private brain gets the private posture,
  stated with its trade-off: private facts are readable by the local CLI only,
  so remote agents cannot recall them later. An explicit private setting is
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
degraded (`degraded_dedup`) — near-duplicate phrasings may insert. See
[spend-controls](../operations/spend-controls.md) for the brain-wide
extraction switches.

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
results from the serve-side harvest receipts. Counters are local, append-only,
loss-tolerant observability — never a source of truth.

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
