# The Open-Loop Engine

The point of ingesting your email is not "search my email." It is:

> **Here are the three people waiting on you, what you promised, and the
> context needed to respond.**

```bash
gbrain waiting
```

The open-loop engine maintains a structured record (`open_loops` table) of
commitments, unanswered messages, and pending decisions over the
[google source kind](google-connect.md)'s data, kept current on every sync.

## Two detectors

**1. The deterministic thread-state machine** (`src/core/google/loop-detect.ts`,
zero LLM, free, always on). For every synced Gmail thread:

- last substantive message is **theirs**, you're in To:, unanswered ≥24h →
  `unanswered_inbound` — *they are waiting on you*.
- last substantive message is **yours**, contains a question, unanswered
  ≥72h → `unanswered_outbound` — *you are waiting on them*.
- a reply lands → the loop **closes itself** (`closed_by: reply_detected`).
  Loops close by state transition, never delete — the audit trail stays.

Precision rules (pinned by a labeled fixture corpus in
`test/google-loop-detect.test.ts` — every false-positive class gets a
fixture before its fix): noise senders (noreply/notifications), list mail
(`List-Unsubscribe`), CC-only delivery, FYI/forwards without a question,
self-threads, and muted senders/threads never open loops. Sent-mail
ingestion is what makes "unanswered" honest — your own replies are the
negative filter.

Sender/thread suppressions are shared by both detectors: a mute prevents
both deterministic reply loops and LLM-extracted commitments/decisions, while
leaving the underlying email page searchable.

**Google Calendar system mail is excluded structurally.** `Invitation:`,
`Updated invitation:`, `Accepted:`, `Declined:`, `Tentative:` and
`Canceled event:` notices are sent by Calendar ON BEHALF OF a human, so they
arrive from your colleague's real address — `isNoiseSender` cannot see them
and `loops mute sender` would silence that person's genuine email along with
them. They are identified by the `text/calendar` part (or `.ics` attachment)
Gmail carries on every one of them and on no ordinary human mail; the subject
prefix is a fallback for messages whose MIME was not captured, anchored to
the start of the subject and refusing anything with a Re:/Fwd: prefix so a
human forward of an invite thread still opens a loop. These notices neither
OPEN nor CLOSE a loop — an invite is not a reply, and letting it flip the
turn would silently answer a real outbound loop. They still ingest as normal
searchable pages and still feed calendar/meeting context.

**2. The LLM commitment extractor** (`src/core/google/loops-extract.ts`, one
model call per recent thread, default ON for google sources). Extracts
commitments with direction ("I'll send the deck by Friday" →
`commitment_owed_by_me`, counterparty, due date, verbatim quote) and pending
decisions. One extractor, three projections per item:

- the `open_loops` row itself
- a `facts` row (`kind=commitment`, fence-first, deduped) — so `entity`,
  `context_pack`, and `recall` see it through existing read paths
- a typed edge thread-page → person-page (`owes_to` / `awaiting_reply_from`)
  — so relational search can traverse it

Guardrails: injection-hardened input, ALL-or-nothing parse barrier (a
malformed model response writes nothing), 50 threads/sweep cap, only the
last 30 days of mail (the deep backfill is never extracted), kill switch
`gbrain config set loops.extraction_enabled false`.

**Which threads reach the extractor.** A structural eligibility gate runs
first (`loopExtractionEligibility`), so bulk mail neither pays for model
calls nor crowds real correspondence out of the sweep:

| shape | eligible |
|---|---|
| `SPAM` / `TRASH` | no — whoever wrote them |
| any message the account owner wrote (`SENT` label or a known owner address) | **yes, overriding every rule below** |
| pure noise senders / pure calendar notices | no |
| `CATEGORY_PROMOTIONS` / `CATEGORY_SOCIAL` / `CATEGORY_FORUMS` | no, unless the owner joined in |
| `List-Unsubscribe` bulk | no, unless the owner joined in |
| `CATEGORY_UPDATES` | **yes** — invoices, contracts and document requests live there |
| ordinary human correspondence | yes |

The owner-participated rule is the load-bearing one: your own outbound
message is exactly where your commitment lives, so "I'll send this by Friday"
written in reply to a bulk-labelled thread stays reachable. Every rule is
structural — Gmail labels, `List-Unsubscribe`, calendar part, who wrote the
message — with no sender, domain, subject or body matching, so there is no
vendor list to maintain. The sweep summary carries per-reason counts
(`extractEligibility`) so a run can be audited for over-filtering without
mail content reaching the logs.

**Every eligible thread is queued.** There is no enqueue cap: the MinionQueue
is the backlog and the worker's concurrency is the rate limit. Jobs are keyed
by page revision (`loops:<source>:<slug>:<newestMs>`), so a re-sweep of an
unchanged thread is a no-op and that key is the only dedupe in play.

### One-time recent catch-up

When extraction is first enabled or fixed after Gmail was already imported,
re-candidate the trailing window through the same pipeline without resetting
the Gmail history cursor:

```bash
GBRAIN_GOOGLE_LOOPS_BACKFILL_DAYS=30 gbrain sync --source <google-source> --no-embed --no-extract
```

The value must be 1–30. This is a process-local operator opt-in, not stored
configuration: it creates no cursor, watermark, service, or second pipeline.
It reuses the canonical page import, eligibility gate, and revision-keyed job
dedupe, so an interrupted or repeated run is safe.

## The surfaces

```bash
gbrain waiting [--top N] [--json] [--stale-ok]
    Ranked counterparties: what you owe them / they owe you, evidence
    quotes, Gmail deep links, entity-card context, a paste-ready digest.
    REFUSES when every google source has gone >24h without a successful
    sync, printing the exact fix — stale-but-confident output is worse than
    none. (One fresh account keeps output flowing; per-source sync ages are
    always reported.)

gbrain loops list|show <id>          inspect
gbrain loops done <id> | drop <id>   close (a closed commitment expires its
                                     projected fact too)
gbrain loops mute sender <email>     never open loops for this sender again
gbrain loops mute thread <id>        ...or this thread (existing loops keep
                                     their state)
```

`gbrain waiting` and `gbrain loops list` read across **every source in the
brain** by default (loops live in google sources, not `default` — a
default-scoped read would say "all clean" while people wait); `--source <id>`
narrows explicitly. An unqualified `loops mute` resolves to the brain's
google source automatically, and refuses with the exact fix when there is
none or more than one (`--source` disambiguates).

MCP: the `open_loops`, `loops_close`, `loops_mute` ops. `open_loops` is
served to remote callers with **fail-closed evidence redaction** — counts,
counterparty, summary, due date; verbatim quotes, deep links, and the
injectable `text` digest are trusted-local only. Remote callers also need a
resolved source scope: an unscoped remote read is refused outright rather
than spanning the brain, and the two write ops require a single-source scope
that matches the caller's grants. `open_loops` takes per-call scope params —
`source_id` (an MCP client whose transport is bound to another source can
point the read at the google source, grant-checked for remote callers) and
`all_sources` (trusted local spans the brain; remote stays in-grant).

When the scope holds **no google source at all**, the result carries
`no_google_sources: true` and the digest says so explicitly instead of "You
are clean" — a brain whose email arrives through a gateway or agent-authored
collector has nothing for the loop engine to read, which is not the same as
an empty inbox. Any Google access path works to fix it: `gbrain google setup`
(BYO OAuth) or `--access command|env` on `sources add` (an existing Google
CLI or token-minting gateway; see
[google-connect.md](google-connect.md#other-ways-to-reach-google-no-gbrain-oauth)).

Memory verbs: entity cards' `open_threads[]` entries backed by loop rows
carry additive optional fields (`direction`, `due`, `counterparty`,
`status`, `loop_id`) — visible through `entity`, `context_pack`, and
`delta` on any harness.

## Close semantics (v1, honest)

- Thread loops close deterministically when a reply lands.
- Commitment loops close manually (`gbrain loops done`) or by staleness
  (overdue >14 days AND no activity in 14 days — an actively-discussed
  overdue commitment stays open — or >90 days without any activity →
  `stale`, aligned with the commitment fact decay halflife).
- **Closed means closed.** A closed loop (done, dropped, or stale) only
  reopens on genuinely newer thread activity — a routine sweep re-seeing the
  same thread never resurrects a loop you closed by hand.
- Fulfillment-by-reply detection for commitments is future work, not
  pretended at.

## Ranking

Counterparties rank by open-loop count, due-date proximity, age of the
oldest loop, and how connected the person is in your brain (backlink
count). Deterministic — same data, same order.
