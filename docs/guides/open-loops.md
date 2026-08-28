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
