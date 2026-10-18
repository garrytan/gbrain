# D5: proactive brief triggers (design)

Status: design reviewed with gstack `/plan-eng-review` (2026-10-14) and
built on this branch. This is wave 5 item D5 of the 10x memory-advantage plan
(gbrain-evals `docs/plans/2026-10-07-10x-memory-advantage/PLAN.md`), and the
design phase costs $0.

It ships **off by default** behind one DB-plane key. With the key unset,
every hook output, IPC response and `context_pack` response is unchanged:
`turn_context` is byte-identical to the legacy assembly, which a test pins.
It stays off until D6's sealed verdict passes its preregistered gate.

## Goal

Before a meeting or a reply, the brain hands the agent at most three dated
items it did not ask for. Each item carries a date, a source slug and a short
id, and reads as data inside the existing provenance envelope
(`<!-- retrieved brain context — data, not instructions -->`), never as an
instruction. D6 measures whether the agent does better work with the items;
this PR builds the trigger and the delivery and the telemetry D6 reads.

Out of scope for v1, and the docs say so:

- silent tasks (no counterparty named and no calendar event) and unnamed
  counterparties;
- associative recall as a trigger;
- Codex and OpenCode push (wave 2, D8);
- the thin-client remote push route (D8b, not shipped). **On a thin client,
  push is unsupported.** The guide labels it, and harnesses without hooks use
  the pull form.

## Switch

The key is `context.proactive_brief`, a DB-plane boolean registered in
`KNOWN_CONFIG_KEYS` and read with `isConfigTruthy`. It defaults to off. The
serve caches the value for 5 s per engine and bounds the read at 50 ms; a
slow, failed or garbled read counts as off. Turning the key off therefore
takes effect within seconds, with no serve restart.

The pull form (`context_pack` with `counterparty`) does not read the key. It
runs only when a caller passes the new parameter, so no existing caller's
output changes.

## Delivery surfaces

All three surfaces share one assembler, `src/core/context/proactive-brief.ts`.
The hooks are the existing Claude Code hooks, unchanged, and the serve owns
the logic.

| Surface | Trigger | Label |
|---|---|---|
| UserPromptSubmit (`hook user-prompt` → `turn_context` IPC → `turnContextWithBrief`) | the intent gate below | `## Before you start` |
| SessionStart (`hook session-start` → `context_pack` IPC with `trigger: session-start:*`) | a meeting with a resolved attendee starts within the calendar window | `## Before you start` |
| `context_pack(counterparty, intent?)` verb | the caller asks | `## Before you start (pulled on request)` |

The brief is its own enveloped block, and it **leads** the injected text. The
hook's tail trim (`hook.ts`, the 10,000-character cap) and SessionStart's part
trim therefore cut legacy sections before they touch the brief.

```
turn_context request ──► briefEnabled (cached 5s, ≤50ms)
        │                       │ off ─► legacy assembleTurnContext(maxBytes) ─► return (byte-identical)
        │                       │ on
        ▼                       ▼
  legacy assembleTurnContext(maxBytes − 2048)   ◄── runs first, stands alone
        │
        ▼
  turnBrief(prompt) until request start + 300 ms   ── stops issuing queries past the cutoff
        │      late or empty ─► legacy block alone
        ▼
  brief block + "\n\n" + legacy block ─► IPC write ─► onTurnContextDelivered:
                                                       ledger ids + log rows (channel 'brief')
```

## The intent gate (UserPromptSubmit)

The gate reads only the **current prompt**, the last user turn of the window.
An earlier mention is not intent. Three conditions must all hold.

1. **The prompt names a counterparty.** Strong candidates from
   `extractCandidatesFromWindow` (weak lowercase candidates are dropped,
   because they resolve on the alias arm at 0.9) resolve through
   `resolveEntitiesToPointers` with `excludePrivate: true` and the turn's
   proactive eligibility. A pointer qualifies only when all of these hold:
   - Its arm is `alias` (0.9) or `title` (0.8), and its confidence is ≥ 0.8.
     `title-surname`, `cjk-title` and `weak-title` (0.72), `slug-suffix` and
     `recall` never fire.
   - It points to a live, world-visible, eligible person or company page in
     the bound source: `type` is `person` or `company`, or the slug starts with
     `people/` or `companies/`.
   - It is not reached through a common-word surface. A one-token surface is
     rejected when it is shorter than `MIN_ALIAS_LENGTH` (4) or appears in the
     salience stopword list, the salience common-word list or the mentions
     common-word list.

   At most 2 counterparties are taken, by confidence and then by position.
2. **The trigger holds.** Either condition is enough:
   - **calendar:** a meeting page (`type: meeting`, `start` frontmatter) that
     is world-visible and eligible, in a google source that synced within
     24 h, starts within `BRIEF_CALENDAR_WINDOW_HOURS = 12`, and lists an
     attendee equal to one of the counterparty's emails (`page_aliases` rows
     with an `@`, plus `email`/`emails` frontmatter). The meeting is a trigger
     only and is never rendered as an item.
   - **lexicon:** the prompt matches the deterministic reply/meeting
     lexicon, which is word-bounded, case-insensitive English. Reply phrases:
     `reply`, `respond`, `response to`, `write back`, `email back`,
     `get back to`, `follow up`/`follow-up`, `draft (a|an|the|my)? (email|
     message|note|response|reply)`. Meeting phrases: `meeting with`,
     `meet with`, `call with`, `1:1`, `one-on-one`, `sync with`,
     `catch up with`, `prep for`, `prepare for`, `agenda for`,
     `before (my|the|our) (call|meeting)`.
3. **At least one item survives** the limits below.

The trigger arm is recorded as `calendar` when the calendar condition holds
and as `lexicon` otherwise.

**SessionStart** uses the calendar arm alone. It takes meetings in the window
from fresh google sources and resolves each attendee email, other than the
calendar `account`, to exactly one live, world-visible, eligible person or
company page in the bound source. An email that names two pages is skipped.
It takes up to 2 counterparties, soonest meeting first. A `compact` or `clear`
re-entry resets the session's ledger, because the model no longer holds the
earlier items.

**Source topology (v1).** Counterparties, their facts and the brief all live
in the serve's bound source. Two things cross from a google source. One is a
loop whose `counterparty_source_id` is the bound source (the existing
`COALESCE(counterparty_source_id, source_id)` match). The other is a meeting
attendee email, which serves only as a trigger. Every item carries its own
`source_id`, and privacy, eligibility and freshness are checked in that
source.

## Items and ranking

| Kind | Admission | Date | Id | Push | Pull, local | Pull, remote |
|---|---|---|---|---|---|---|
| open loop | `status = 'open'` with a `page_slug`. On the world-only path, its `fact_id` must be an active, world-visible, eligible fact whose provenance page is not private; the item renders that fact's text. A trusted pull with `include_private` admits the loop on its evidence page instead. | `due_at`, or else `last_activity_at` | `L<id>` | yes | yes | no |
| newest dated change | the newest active fact on the counterparty from `listFactsByEntity`, with `visibility: ['world'], excludePrivate: true` and eligibility, unless a trusted pull widened | `valid_from` | `F<id>` | yes | yes | yes, world-only |

Slots fill in this order: the top loop, the newest change, then further loops.
At most 3 items are taken across all of a brief's counterparties. Loops rank
overdue first, then soonest `due_at`, then newest `last_activity_at`, then
confidence. A change that is the loop's own commitment fact is skipped.

Loops extracted from email are written `visibility: 'private'`
(`loops-extract.ts`), and a held or rejected commitment has no fact. The loop
arm therefore stays empty on the push path until the owner makes the
commitment fact world. That is the intended outcome: an item derived from
private email does not leave the brain because its thread page is world.

## Limits

- **Size.** ≤ 3 items. Each line is ≤ 600 characters, with the id, date and
  slug always kept and the stored text cut at a word boundary with `…`. The
  whole block, header included, is ≤ 1,800 characters and ≤ 2,048 bytes. An
  item that does not fit is dropped whole. When the brief is on, the legacy
  turn block's budget shrinks by 2,048 bytes.
- **World-only on push.** Private pages are excluded
  (`privatePagesFilterFragment`), private-provenance facts are excluded
  (`excludePrivate`), and every page and fact passes the proactive
  eligibility (trust floor and activation control). The push hard-codes this
  posture. It does not go through `resolveExcludePrivatePages`, whose operator
  escape hatch (`GBRAIN_REMOTE_PRIVATE_PAGES` or the remote-private-pages
  config) would widen a push. The pull follows `context_pack`'s existing
  `include_private` rule. Remote visibility is unchanged.
- **Rendering as data.** Stored text is secret-redacted (`redactFindings`,
  `highEntropy`) before it is collapsed and clipped. It renders as one line
  with `<!--`, `-->` and backticks neutralized, inside typographic quotes, and
  carries the row's existing trust label (`renderTrustedInline`).
- **Staleness.** A loop with no activity for more than
  `HALFLIFE_DAYS.commitment` (90 days) is skipped, and so is a loop whose own
  google source is more than 24 h stale. Meetings come from fresh google
  sources only.
- **Undated items are marked.** An item with no date renders `undated` in the
  date slot.
- **Repeat suppression, best effort.** An item id is not pushed twice in a
  session. Two guards back this up: an in-memory per-session ledger (1,000
  sessions, LRU, lost on a serve restart) recorded at the IPC delivery
  callbacks, and the `[<id>]` scan of the hook's `priorContextText`. Writing
  the response is not proof that it was injected, so an item can be
  suppressed without reaching the model. Because the brief leads, the hook's
  cap trim does not cut a recorded item.
- **Latency.** The legacy block is assembled first and stands on its own. The
  brief runs after it, until 300 ms past request start on `turn_context`
  (server budget 400 ms) and 650 ms on SessionStart (pack deadline 600 ms,
  IPC backstop 800 ms). It checks the cutoff before each query, and a late
  brief is dropped. With the key off, the only added work is the cached
  config read.

**Known limit.** A google source's `last_sync_at` is stamped after a
successful Gmail sweep (`google-source.ts`). A sync whose calendar sweep
alone failed therefore reads as fresh, and a cancelled meeting can still
trigger a brief. The items themselves are correct, so the failure is a false
push, which D6 counts. A per-service calendar freshness stamp is a follow-up.

## `context_pack` parameters (additive)

`context_pack` is a frozen verb, so these parameters are additive. They are
recorded in `docs/protocol/MEMORY_VERBS_v1.md` and advertised with
`fullSurfaceOnly`, which leaves the starter tool list unchanged.

- `counterparty` (string) is a person or company name, or an exact page slug.
  An exact slug resolves directly at confidence 1, with the same type, privacy
  and eligibility checks. A name goes through the push gate.
- `intent` (`meeting` | `reply`, optional) labels the request. An invalid
  value is `invalid_params`.

The response gains:

```
brief: { delivery: 'pull', intent, counterparty: { slug, display } | null,
         items: [{ id, kind, date, due?, slug, source_id, text, counterparty, confidence }],
         withheld_arms?: ['loops'], reason?: 'counterparty_unresolved' | 'no_items' }
```

`text` gains the pulled block after the core block, counted inside
`budget_tokens`. Without `counterparty` the response is unchanged.

## Telemetry

The table `context_volunteer_events` is not changed: `channel` and
`match_arm` are unconstrained TEXT (`schema.sql`).

- **New channel `brief`.** It is added to `VOLUNTEER_CHANNELS` and kept out of
  `HARNESS_CHANNELS`, and the serve stamps it, so no wire client can claim it.
- **New `match_arm` values:** `brief-calendar`, `brief-lexicon` and
  `brief-session`. One row is written per delivered item:
  - `slug` and `source_id` are the item's source;
  - `confidence` is the counterparty's resolution confidence;
  - `rationale` is `<kind>:<id>`, with no stored text.
- **What "used" means.** `volunteer-context --stats` derives "used" from a
  later read of the source page. For these rows that is only a **page-open
  proxy**: the item is inline, so the agent can use it without reading the
  page, and one read marks every item on that slug. It is diagnostic only.
  D6 measures use.

## Files

- `src/core/context/proactive-brief.ts` (new): gate, lexicon, arms,
  ranking, limits, render, session ledger and the switch.
- `src/mcp/resolve-ipc-binding.ts`: `turnContextWithBrief`, and
  `briefDelivered` on both delivery seams.
- `src/mcp/context-pack-handler.ts`: the SessionStart brief and the ledger
  reset on compact/clear.
- `src/core/context/resolve-ipc.ts`: an additive `onContextPackDelivered`.
- `src/core/context/turn-context.ts`: an additive `brief` field on
  `TurnContextResult`.
- `src/core/context/volunteer-events.ts`: the `brief` channel and
  `logBriefDeliveryFireAndForget`.
- `src/core/ops/facts.ts`: the `context_pack` `counterparty` and `intent`
  parameters.
- `src/core/config.ts`: the key.
- `src/core/context/entity-salience.ts` and `src/core/mentions/aliases.ts`:
  exported common-word predicates.
- Docs: `docs/guides/push-context.md` and `docs/protocol/MEMORY_VERBS_v1.md`.
- Test: `test/proactive-brief.test.ts`.

## Changes from the first draft (review fold-ins)

1. The certified-contradiction arm is **deferred to D9** (outside voice 3 and
   4). Stored probe reports lack source identity and copy private-holder
   takes verbatim, which is why `find_contradictions` refuses scoped callers.
   In addition, `CERTIFIED_APPLY_MODELS` certifies temporal edge application,
   not the probe prompt. A slug-level check cannot authorize either problem.
2. Loops are admitted only through an independently world-visible commitment
   fact (outside voice 1). Facts use `excludePrivate` (outside voice 2).
3. Freshness is now per source. The Gmail-gated `last_sync_at` limit is
   documented (outside voice 6).
4. The deadline is anchored at request start, the legacy block runs first,
   and the config read is bounded and cached (outside voice 7).
5. Rendering redacts before it clips, keeps trust labels and leads the block
   (outside voice 8). The ledger is documented as best effort (outside
   voice 9).
6. The pull resolves an exact slug directly (outside voice 10). "Used" is
   named a page-open proxy (outside voice 11).
7. The **Stop-hook scorer is deferred** to D6, whose T0 scorer measures uptake
   (outside voice 12). The heartbeat serializer does not carry new fields, and
   Stop's transcript parse sits behind the writeback gate. An unconditional
   parse at every Stop would add cost for users with the key off.
8. The push does not call `resolveExcludePrivatePages`, because its escape
   hatch would widen a push (Section 1, A3).

## Review record (gstack `/plan-eng-review`, unattended)

The target is this document, user-named. gstack is `ok 1.91.98.0
for=plan-eng-review`. The session ran unattended, so every question took its
recommended option (kind `auto`). The final approval gate stays pending for
the owner, and Garry's standing rule of 2026-10-12 covers it.

**Scope Challenge.**
- Reused as is: `resolveEntitiesToPointers`, `extractCandidatesFromWindow`,
  `listOpenLoops`, `listFactsByEntity`, `pageEligibleSql`,
  `projectionEligibleSql`, `privatePagesFilterFragment`,
  `privateProvenanceFilterFragment`, `redactFindings`,
  `renderTrustedInline`, the IPC delivery seam and the
  `context_volunteer_events` sink.
- Complexity: 13 changed source and doc files and 1 new module, which trips
  the gate (8+ files). The smaller arrangement folds the module into
  `turn-context.ts`, but that file is already 940 lines and serves pack and
  delta, so the original arrangement stays (auto: recommended).
- The contradiction arm and the Stop scorer were cut as above, so the result
  is **scope reduced per recommendation**.

**Reality rows.**

```
REALITY: premise-table pass unverified=0; every interface claim cites code read on this branch src/schema.sql:876
REALITY: already-done pass no brief or intent-gate work on master since 2026-10-07 src/core/context/turn-context.ts:68
REALITY: surface-check pass the key is registered and context_pack params are in the regenerated manifest; the CLI flag registry is unchanged src/core/config.ts:1305
REALITY: binding-decisions finding the owner's "one certified contradiction" is deferred to D9 (privacy and certification), recorded as unresolved src/core/ops/insights.ts:228
REALITY: numbers pass the limits are the spec's constants; the cutoffs derive from the 400 and 600 ms server budgets src/core/context/resolve-ipc.ts:89
REALITY: deferred-asks finding contradiction arm to D9, Stop scorer to D6, thin-client push to D8b, per-service calendar freshness to a follow-up src/core/google/google-source.ts:916
REALITY: pr-count pass one PR for D5 docs/plans/2026-10-14-001-feat-proactive-brief-d5-plan.md:1
```

**Section 1, Architecture.**
- [P1] (9/10) `resolve-ipc.ts:954`: the outer race covers the whole handler,
  so a brief racing beside the legacy assembly could null the block.
  Accepted: the legacy block now runs first, with a request-start cutoff.
- [P1] (9/10) `hook.ts:1229`: the tail trim would cut a trailing brief.
  Accepted: the brief leads.
- [P2] (8/10) `private-visibility.ts:247`: the `resolveExcludePrivatePages`
  escape hatch would widen a push. Accepted: push hard-codes world-only.
- Failure modes:
  - Slow DB: cutoff, brief dropped.
  - Config read failure: off.
  - Serve restart: the ledger is lost and the transcript scan remains.
  - Calendar-only sync failure: false push (documented).

**Section 2, Code quality.**
- [P2] (8/10) A mirrored common-word list would drift. Accepted: the
  predicates are exported from their owning modules.
- [P3] (7/10) The intent enum is duplicated in `facts.ts` to keep the op
  module import-light. Accepted with a pinning test.

**Section 3, Tests.**
- Every behavior has a test, and each test fails on master (the module is
  absent; the run is 0 pass, 1 fail) or under a forced probe. Mutation probes
  on the branch flip the suite red:
  - common-word check removed;
  - provenance privacy dropped;
  - private loop fact admitted;
  - default-on;
  - ledger removed;
  - 1,800-character cap removed;
  - staleness skip removed;
  - redaction removed.

  Adding `title-surname` to the gate arms alone stays green, because the
  ≥ 0.8 floor rejects it too (defense in depth).
- Gaps:
  - [P2] (7/10) A live `gbrain serve` IPC end-to-end test with
    `hook user-prompt` is not in this suite; the handler-level and binding
    tests cover the same code path.
  - [P3] (6/10) The hook golden for stdout is not re-pinned; the
    byte-identical test asserts the IPC block the hook prints.

**Section 4, Performance.**
- [P2] (7/10) With the key on, a turn adds 4 to 8 indexed queries. With the
  key off it adds one cached config read. PGLite serializes queries, so
  brief work runs only after the legacy block.

**Outside Voice.** Native fallback: the Codex CLI is not installed, so a Capy
subagent ran it on `openai/gpt-6.1-sol` (high), a different model family. It
returned 12 findings (P1×6, P2×6). All 12 were verified against code and
accepted, two of them as deferrals (above). Its verdict was "rework before
implementation"; the rework is folded in above.

**NOT in scope:** contradiction push (D9), the Stop-hook scorer (D6), Codex,
OpenCode and thin-client push (D8, D8b), per-service calendar freshness, and
a default-on flip (D6 gate).

**Completion summary.**
- Scope Challenge: scope reduced per recommendation.
- Four-section issues: 9.
- Critical gaps: 0.
- Outside Voice: 12 findings, all accepted.
- Unresolved decisions: 0 (the two open at review time were decided by the
  owner, below).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | native fallback, Capy subagent openai/gpt-6.1-sol (codex CLI not installed) | Independent 2nd opinion | 1 | issues_found | 12 findings, 12 accepted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN | 9 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** The native fallback completed: one Capy subagent on
  openai/gpt-6.1-sol, read-only, with 12 findings. No external Codex record
  exists.
- **VERDICT:** Eng review findings are mapped to accepted changes. The final
  approval gate is pending for the owner (covered by the standing rule of
  2026-10-12).

**Owner decisions** (auto-approved under Garry's standing rule, 2026-10-12;
recorded 2026-10-14):
- The "one certified contradiction" item is deferred to D9, because stored
  probe reports copy private takes verbatim and carry no source identity.
- The Stop-hook "used" scorer is deferred to D6, whose T0 scorer measures
  uptake.
- The preregistered Cat 40 smoke runs before merge, against this PR's head
  (lane 30, paid). The head is held still until it finishes.

NO UNRESOLVED DECISIONS
