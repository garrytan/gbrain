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

**Google Calendar system mail is excluded structurally.** `Invitation:`,
`Updated invitation:`, `Accepted:`, `Declined:`, `Tentative:` and
`Canceled event:` notices are sent by Calendar ON BEHALF OF a human, so they
arrive from your colleague's real address — `isNoiseSender` cannot see them
and `loops mute sender` would silence that person's genuine email along with
them. They are identified by the iCalendar `METHOD` (`REQUEST`, `REPLY`,
`CANCEL`, … — the RFC 5546 values; nothing else counts) that Gmail carries in
the `text/calendar` part's own Content-Type header on every one of them and on
no ordinary human mail; a human attaching an `.ics` file, or an unrecognized
method value, is not a stamp. The subject prefix is a fallback for messages
whose MIME was not captured: anchored to the start of the subject, limited to
Calendar's own headers (a generic word like `Notification:` is a human or
vendor subject and never matches), and refusing anything with a Re:/Fwd:
prefix so a human forward of an invite thread still opens a loop. These notices neither
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

Guardrails: injection-hardened input (the model sees the NEWEST 12k of the
thread, so the latest reply is always visible to the judge), ALL-or-nothing
parse barrier (a malformed model response writes nothing), only the last 30
days of mail (the deep backfill is never extracted), kill switch
`gbrain config set loops.extraction_enabled false`. With no chat provider
configured (a keyless install, or an outage) the sweep enqueues no
extraction jobs and logs one line saying so — the email pages still import,
and the threads are extracted on their next touch or by
`gbrain sync --source <id> --full` once a provider exists; a job that hits
the outage mid-flight retries and, if it dies, frees its slot rather than
completing empty. Sender/thread
suppressions are shared by both detectors: `loops mute` also stops the LLM
lane from recreating a commitment or decision for a muted sender/thread,
while leaving the underlying email page searchable. A sender mute gates on
who **wrote** in the thread — every message author, not only the newest —
and never on recipients or CC: muting one person does not hide everyone
else's commitments in a group thread they were copied on, and an outside
sender cannot dodge extraction by CC'ing a muted address. Thread pages carry
the author list as `senders:` frontmatter beside `participants:`.

**Which threads reach the extractor.** A structural eligibility gate runs
first (`loopExtractionEligibility`), so bulk mail neither pays for model
calls nor crowds real correspondence out of the sweep:

| shape | eligible |
|---|---|
| `SPAM` / `TRASH` | no — whoever wrote them |
| a substantive message the account owner wrote (`SENT` label or a known owner address; a calendar RSVP or other noise does not count) | **yes, overriding every rule below** |
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
vendor list to maintain. The sweep logs per-reason counts
(`loops_extract eligibility:`) so a run can be audited for over-filtering
without mail content reaching the logs.

**Every eligible thread is queued** (newest first — ordering only, nothing is
dropped for being older). The MinionQueue is the backlog and the worker's
concurrency is the rate limit; the old tight per-sweep cap silently lost
threads (a thread only re-candidates when it changes). Jobs are keyed by page
revision (`loops:<source>:<slug>:<newestMs>`), so a re-sweep of an unchanged
thread is a no-op and that key is the only dedupe in play. A generous safety
ceiling (500/sweep) remains purely as a spend backstop for pathological
sweeps; when it binds, the log names the drop honestly.

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
gbrain loops unmute sender <email>   undo a mute — the detector may open new
gbrain loops unmute thread <id>      loops for it again
```

**Say to your agent:** *"Who is waiting on me?"* / *"open loops"* — routes to
the google-loops skill, whose daily-operation runbook covers muting: your
agent runs `gbrain loops mute sender <email>` to stop tracking a sender and
`gbrain loops unmute sender <email>` to undo it (unmute has no trigger of its
own; the agent reaches for the command directly).

`gbrain waiting` and `gbrain loops list` read across **every source in the
brain** by default (loops live in google sources, not `default` — a
default-scoped read would say "all clean" while people wait); `--source <id>`
narrows explicitly. An unqualified `loops mute` resolves to the brain's
google source automatically, and refuses with the exact fix when there is
none or more than one (`--source` disambiguates). `loops unmute` resolves
its source the same way, so an unmute cannot aim at a different source than
the mute it reverses.

**Unmute is exact and forward-only.** It deletes the one
`(source_id, kind, value)` row the mute wrote — the same lower-casing, so
`unmute sender BOB@Example.com` reverses `mute sender bob@example.com`, while
a sibling source, the other `kind`, or a different value are untouched. It
does **not** reopen loops: suppressions gate NEW detection only, so anything
closed or never opened while the mute was in place stays that way; the
detector simply resumes opening loops from the next sync. A repeated unmute
is a no-op that reports `removed: false` and exits 0, so a script may call it
unconditionally without special-casing "was not muted".

MCP: the `open_loops`, `loops_close`, `loops_mute`, `loops_unmute` ops. `open_loops` is
served to remote callers with **fail-closed evidence redaction** — counts,
counterparty, summary, due date; verbatim quotes, deep links, and the
injectable `text` digest are trusted-local only. Remote callers also need a
resolved source scope: an unscoped remote read is refused outright rather
than spanning the brain, and the write ops require a single-source scope
that matches the caller's grants (`loops_unmute` included — lifting another
source's suppression is as much a targeted write as planting one). `open_loops` takes per-call scope params —
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
