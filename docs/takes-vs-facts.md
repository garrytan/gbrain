# Takes vs Facts — Architectural Distinction

gbrain has two epistemological storage layers that serve different purposes.
**Never conflate them.**

## Takes (cold storage — `takes` table)

The epistemological layer. WHO believes WHAT, with confidence weight and time.

- **Source:** Extracted from brain pages (markdown) by LLM analysis
- **Scope:** Multi-holder — captures beliefs from *any* speaker, not just the brain owner
- **Kinds:** `take` (opinion), `fact` (verifiable), `bet` (prediction), `hunch` (intuition)
- **Lifecycle:** Cold storage, retrospective. Updated when pages change or re-extraction runs.
- **Scale:** 100K+ rows across thousands of holders in a mature brain

**Example takes:**
- `holder=people/alice-example kind=bet` "AI will replace 50% of coding by 2030" (w=0.75)
- `holder=people/bob-example kind=take` "widget-co has strong retention" (w=0.80)
- `holder=world kind=fact` "acme-example raised a Series C" (w=1.0)
- `holder=brain kind=hunch` "alice-example has a hero/rescuer pattern" (w=0.70)

**Query surface:** `gbrain takes list`, `gbrain takes search`, `gbrain takes search --semantic`, `gbrain think`

Take vectors (used by `takes search --semantic` and the `think` vector stream)
are kept current by `gbrain embed --stale`, which the cycle's embed phase runs:
it embeds every active take that has no vector, whose claim changed since it
was embedded, or whose vector came from another embedding model. Each vector
records the model and the claim text it was computed from. Takes on deleted
pages or archived sources are skipped. `gbrain takes embed` runs the same pass
on its own; `gbrain takes embed --dry-run` shows the pending provider work
without making calls.

To stop automatic take embedding, run `gbrain config set takes.auto_embed false`
(or set `GBRAIN_EMBED_TAKES=0` for one process; the variable wins over the
config key). `gbrain takes embed` keeps working when it is off.

`gbrain migrate embeddings` moves take vectors with the rest of the brain: the
plan counts stale takes, a width change resizes `takes.embedding`, the re-embed
drain refills it, and the run does not complete while takes are still stale.
`gbrain doctor` reports takes and facts without a current-model vector in the
`fact_take_vectors` check ([verification runbook](GBRAIN_VERIFY.md#5a-fact-and-take-vectors)).
Until take vectors exist, `think` falls back to keyword-only takes retrieval and
`takes search --semantic` simply reports no semantic matches.

## Facts (hot memory — `facts` table)

Personal knowledge from the brain owner's conversations. Real-time capture.

- **Source:** Extracted per-turn from conversation by the facts hook (Haiku)
- **Scope:** Single-user — only the brain owner's stated knowledge
- **Kinds:** `event`, `preference`, `commitment`, `belief`, `fact`, `idea`
  (`idea` is extractor/DB-only — the frozen `remember` verb enum stays at five,
  per `docs/protocol/MEMORY_VERBS_v1.md`)
- **Lifecycle:** Hot storage, real-time. Captured as conversations happen.
- **Bridge:** Dream cycle `consolidate` phase promotes hot facts → cold takes nightly

**Example facts:**
- `kind=event` "I have a meeting with alice-example tomorrow"
- `kind=preference` "I don't drink coffee"
- `kind=commitment` "We decided to move the offsite to March"
- `kind=belief` "I think the market is overheated"

**Query surface:** `gbrain recall`, MCP `_meta.brain_hot_memory`

## The Category Error

**Never dump takes into the facts table.** Takes include other people's attributed
beliefs (a partner's assessment of a company, an investor's view on markets, a
founder's revenue claims). These are NOT the brain owner's personal facts.

**Never dump facts into the takes table without transformation.** Facts are
scoped to what the owner said in conversation. They become takes only through
the dream cycle's consolidate phase, which adds proper attribution, deduplication,
and temporal reasoning.

## The Bridge

The dream cycle's `consolidate` phase is the one-way bridge:

```
hot facts → [dream consolidate] → cold takes
```

Facts flow in ONE direction. The consolidate phase:
1. Groups related facts by entity
2. Deduplicates against existing takes
3. Promotes durable facts to takes with proper holder/weight
4. Marks consolidated facts with `consolidated_at` + `consolidated_into`

## Production Extraction Data

Full takes extraction on a ~100K-page brain (measured 2026-05-10):
- **Model:** Azure GPT-5.5 (ties Opus quality at 1/8th cost — $0.033 vs $0.260/page)
- **Result:** 100,720 takes from 28,256 on-disk pages, $361.49, 83 errors (0.3%)
- **Breakdown:** 70,960 takes / 24,342 facts / 2,875 bets / 2,649 hunches
- **Holders:** 6,239 unique holders
- **Cross-modal eval:** 6.8/10 overall (GPT-5.5 + Opus 4.6 scored independently)

### Eval Dimensions

| Dimension | Score | Notes |
|-----------|-------|-------|
| Accuracy | 7.5 | Claims faithfully represent sources |
| Attribution | 6.5 | Holder/subject confusion is the top issue |
| Weight calibration | 7.0 | Good range usage, some false precision |
| Kind classification | 6.5 | Occasional fact/take misclassification |
| Signal density | 6.5 | Some trivial extractions pass through |

### Key Learnings for Extraction Prompts

1. **Holder ≠ subject.** "alice-example has a hero/rescuer pattern" → holder=brain, NOT people/alice-example
2. **Atomic claims.** Split compound claims into separate rows
3. **Amplification ≠ endorsement.** Retweet-only → max weight 0.55
4. **Self-reported ≠ verified.** "Reports 7 figures" → holder=person, weight=0.75, NOT world/1.0
5. **No false precision.** Use 0.05 increments (0.35, 0.55, 0.75), not 0.74 or 0.82
6. **"So what" test.** Skip Twitter handles, follower counts, obvious metadata

## Owner-holder canonicalization

"The brain owner" is, by convention, the holder string **`self`** — the value the
dream `consolidate` phase stamps when it promotes the owner's hot facts into cold
takes. Calibration, `think`, and the `doctor` calibration check resolve the owner
holder through `resolveOwnerHolder` (`src/core/owner-holder.ts`): explicit override
> `emotional_weight.user_holder` config > `self`.

Known limitation: the owner can also
appear under `brain` (a take the owner asserts, via `propose_takes`) and
`people/<owner>` (extraction that names the owner). The resolver selects the
*default* canonical owner string for reads; it does not merge those other
strings. Per-take attribution for other people (e.g. `people/bob-example`) is
unaffected and correct.

## Capture-time fact policy

Automatic extraction (the shared backstop and conversation extraction) can
classify low-value facts before deduplication. Explicit `remember` and
single-fact writes bypass this admission policy. Defaults preserve existing
capture behavior; start with shadow mode to measure potential recall loss.

| Key | Default | Behavior |
| --- | --- | --- |
| `facts.capture_filter` | `off` | `off`, `shadow` (count only), or `on` (drop) |
| `facts.capture_routing` | `off` | `off`, `shadow` (count only), or `on` (route) |
| `facts.routing.broad_types` | `company` | Comma-separated broad page types |
| `facts.routing.home_entities` | empty | Comma-separated exact home slugs; allows home-name mentions, subject to specific_types and decision/analysis vetoes |
| `facts.extraction_low_rubric` | `off` | Only `on` enables the broader low-notability extraction prompt; independent of deterministic filtering |
| `facts.routing.specific_types` | `person,project,deal` | Allowed specific page types or corresponding directories |
| `facts.page_cap.warn_rows` | `0` | Record a warning after publication at this fence row count; 0 disables |
| `facts.page_cap.max_rows` | `0` | Refuse appends at this fence row count; 0 disables |

| Filter category | Admission rule |
| --- | --- |
| `scheduling` | A meeting/call/appointment/invite/reschedul*/attend* token AND future marker (`will`, `scheduled for`, `planned for`, `upcoming`, `invite`, `reschedul*`, `proposed`, `set up`) AND a supported time/date. Veto: `took place`, `was held`, `met`, `had a meeting/call`, `discussed`, `presented`; `about`, `regarding`, `to discuss/share/review/present/negotiate/vote/approve/reject`; or `with` followed by a capitalized name. |
| `shipping` | `tracking number is`, or parcel/courier/tracking number/delivery ETA/customs status/customs clearance/physical shipment followed by a status predicate below. |
| `logistics` | travel booking/hotel/flight/restaurant table/room booking/parking/wifi/wi-fi/password reset link followed by a status predicate below. |
| `spam` | `received`, `arrived`, `sent us` or `in my inbox` AND newsletter/unsubscribe/limited time/sponsored email,message,post,content,offer/promotional offer/webinar invitation/marketing email. |
| `transient` | `is running late`, `out of office until`, `waiting for a reply`, `will send it/this tomorrow`, or `reminder to`. |

A status predicate is `is/was booked/reserved/confirmed/delayed/tracking`, or
bare `booked/reserved/confirmed/departs/lands/arrived/delayed` followed by
end of text, `.`, `!`, `?`, or `on/at/for/until`. The noun must immediately
precede it. Noun modifiers (`flight tracking software`, `hotel check-in kiosks`)
and reversed phrases (`confirmed the flight test date`) stay.
Supported times are HH:MM, a number plus am/pm, noon, midnight, today,
tomorrow, tonight, next week/month, weekdays; supported dates are YYYY-MM-DD,
month plus day (January, February, April, June–December), or D/M/YY(YY).
All matching is case-insensitive except the capitalized-name scheduling veto.

The substance veto runs first: metric kind or a nonempty claim_metric; `$`,
USD/EUR, a digit plus `%`, a number plus k/m/b; decided/agreed/signed/approved/
rejected/hired/raised/closed/invested/terminated/acquired/licensed/filed/must/
will not; patent/IP/FTO/IND/FDA/contract/term sheet/NDA/license/strategy/priority/
risk/competitor/valuation/merger/acquisition; round/Series/revenue/ARR/MRR/
margin/headcount. These keep the claim regardless of every category above.
Unknown cases are kept. Delivery in a technical claim, operating calendars,
commercial discount options and management follow-up are not noise signals.
Stable `capture.<category>.v1` rule IDs identify drops. Counts (`filtered`,
`rerouted`, `capped`, `would_filter`, `would_reroute`) accompany backstop results;
policy and cap events are recorded in the ingest log without claim text.

Routing starts only from a broad entity. Exact slugs, unique basenames and
unique aliases must identify exactly one live specific entity. Fuzzy and
same-name matches never route. Another specific entity, another broad entity,
an unresolved competing real name, a bare first name, any broad title/alias/slug/basename anywhere in the claim,
or a person's possessive (including her/his/their) company/startup/firm veto routing. Role tokens,
ordinary sentence openers and references to nonentity pages do not compete.
Authorization and page-visibility checks still apply. Routed context includes
`routed from <original slug>`.

A withdrawal on the original subject prevents routing; a withdrawal on the
new subject also prevents capture. Withdrawals are subject-scoped, so routing
changes the subject of future facts; it does not migrate existing withdrawals.
Shadow mode leaves stored facts unchanged.

Caps count every parsed fence row, including struck rows. When both thresholds
are enabled, max must be at least warn. Checks occur under the legacy page lock
or managed publication guard. Refused appends create neither a fence row nor a
DB-only/shadow row. Explicit writes receive an error; automatic writes count
refusals. Existing-row strike/rewrite and explicit supersession are allowed.
External archivers remain compatible: archive rows to make space, or increase
`facts.page_cap.max_rows`. Conversation-derived batches stored against their
source conversation do not append entity fences and therefore do not use this
fence cap.

Existing per-caller notability filters already cover low-tier facts. Page-write jobs
freeze `facts.page_write_notability_filter` across retries. The capture filter
only adds the regex categories and gives conversation extraction no new global
notability threshold. Regex categories support shadow mode; enable `on` only after reviewing
shadow counts and representative false positives. Topic-bearing proposed calls
are kept, including a proposed Friday call to discuss scopes. Absolute dates
alone never drop an event; modal "may" and "24/7" are not scheduling dates.

Drops are not stored anywhere. Start in shadow mode. Loosening or disabling a
filter does not restore previously extracted facts: explicitly re-extract the
original sources (which may incur model costs). Managed conversation generation keys include the effective low-rubric flag.
Other capture policy changes do not change that key; force re-extraction after
changing them. A new key does not by itself bypass incremental selection or
restore facts already omitted.

`gbrain facts relink` is exempt from the append cap: it moves facts already
stored in the database into their entity fences rather than admitting new
knowledge. It can exceed `max_rows`; archive rows before subsequent capture.
Conversation-derived database-only batches are also exempt as described above.

**Say to your agent:** "Set the capture filter and routing to shadow, show me
aggregate counts, and let me review examples before enabling drops."

**Say to your agent:** "Set an optional fence row cap, check both thresholds,
and explain how to archive rows or re-extract source material after drops."

### Home routing and the extraction rubric

Home routing is experimental: an earlier broader home-company variant misrouted
2 of 5 predictions on a small held-out sample. Start with routing in `shadow`
and inspect examples before enabling it. Add `company` to specific_types only
if company counterparties should qualify. A home name may be mentioned, but a
home-subject decision (`rejected`, `declined`, `chose`, `selected`, `decided`,
optionally after `has`/`had`) stays on the home page. Analysis tokens
(comparable/comparables, comps, competitor/competitors, benchmark/benchmarks,
positioning, valuation, our strategy, board member, reports directly, headcount,
portfolio company) also veto routing. All other ambiguity, identity, visibility
and withdrawal checks still apply. This routes new facts only. Missing entities
stay unparented under upstream behavior, now pinned by tests.

The opt-in low rubric calls scheduling, travel/shipping/address administration,
marketing/outreach and transient next steps low. With a caller's filter that
drops low facts, the prompt says to skip them entirely: facts are never emitted,
so there are no admission counts or shadow observations for those omissions.
The deterministic filter's shadow setting cannot observe them. A proxy using a
different model from production scored precision 6/10 and recall 6/16; four of
ten rubric low predictions were not labelled DROP. Leave it off unless that
recall tradeoff is acceptable. Turning it off requires explicit re-extraction
to recover omissions. The managed generation fingerprint now includes the flag;
it previously stayed unchanged, and the flag does not alter selection cursors.

**Say to your agent:** "Set home_entities to my exact company slug, keep routing
in shadow, and show me counterparty and home-decision examples. Explain
specific_types before allowing company targets."

**Say to your agent:** "Explain extraction_low_rubric and my caller's low-fact
filter before enabling it. Show the omissions risk and how to re-extract;
shadow counters cannot measure facts the prompt never emits."
