# Evidence delivery (`return_unit`)

> Status: the default is `auto` (v0.60.23.0): conversation pages come back
> whole, every other hit is its unchanged ranked chunk. On LongMemEval-S
> (500 questions, development data) `auto` at a 16,000-token budget answered
> 445 against 312 for chunks (+145 / −12, p = 4e-30) and 457 for whole pages,
> at about 15,100 reader tokens per question against about 3,500. The
> preregistered sealed confirmation set (150 new questions) returned `fail` at
> a ceiling: chunks 147, `auto` 149 (+2 / −0), because its chats are short. It
> showed no benefit and no harm. `auto` ships on the development-data evidence
> while a harder sealed set is built. The default budget was then raised to
> 24,000 tokens to cut session trimming (81 of 500 questions were trimmed at
> 16,000), and a follow-up check measures it. Report:
> [gbrain-evals PR #49](https://github.com/garrytan/gbrain-evals/pull/49)
> (`docs/benchmarks/2026-09-30-evidence-auto-v2.md`). Earlier history: whole
> sessions beat chunks 361/400 against 253/400 while neighbor windows reached
> only 285–292, and a lexical excerpt selector lost 53/60 → 48/60 (see
> [`docs/eval/ANSWER_PACKET_RESULTS.md`](eval/ANSWER_PACKET_RESULTS.md)).

Search returns ranked **chunks**. An agent that needs the surrounding
conversation or section has to call `get_page` for each hit. Evidence delivery
lets `search`, `query`, `recall` and `think` return the surrounding evidence in
the same call: a window of neighboring chunks, the enclosing section, or the
whole page, packed into a token budget.

With `return_unit` omitted the unit is `auto`: hits on conversation pages
(see [Conversation detection](#conversation-detection)) come back as the whole
page, every other hit stays the ranked chunk it was. A response with no
conversation hit is byte-identical to earlier releases. `return_unit: "chunk"`
(or `gbrain config set search.return_unit chunk`) turns the stage off
entirely.

A budget you pass under `auto` is a hard cap: everything delivered (titles,
evidence text and every marker in it) fits inside it, on `query`, `search`,
`recall`'s results and `assemble_evidence`. A call that passes no budget gets
exactly what earlier releases returned. See [Explicit budgets](#explicit-budgets-the-cap).

**Say to your agent:** *"Search my brain for what alice-example said about the
launch date, and read the whole conversation, not just the snippet."*

**Say to your agent:** *"Find every session where we discussed the acme-example
renewal and give me the full sessions within about 6,000 tokens."*

**Say to your agent:** *"What did we decide about the widget-co launch? Keep the
evidence under 8,000 tokens."*

## Quick start

```bash
# CLI
gbrain query "when did we move the launch?" --return-unit page --token-budget 6000
gbrain search "acme-example renewal" --return-unit window --return-window 2
gbrain recall --query "renewal terms" --return-unit section --budget-tokens 4000
```

```jsonc
// MCP
{ "name": "query", "arguments": { "query": "when did we move the launch?", "return_unit": "page", "token_budget": 6000 } }
```

## Units

| `return_unit` | What each result's `chunk_text` holds | Typical cost |
|---|---|---|
| `chunk` | The ranked chunk only (the pre-0.60.23 default). | ~300–450 tokens per result |
| `window` | The hit chunk plus `return_window` (1–3, default 1) neighbor chunks on each side, same page. Overlapping windows merge. | ~3× chunk per result |
| `section` | The enclosing markdown section (by ATX heading). On conversation pages: the user→assistant rounds that overlap the hit. No structure → falls back to `window`. | varies |
| `page` | The whole page or session, capped at 60,000 characters and by the budget. | whole page |
| `auto` (default) | Per hit: `page` for conversation pages, the unchanged ranked chunk for everything else. Each result's `delivered.unit` and `delivered.reason` say which, and why. | whole sessions, 24,000-token default budget |

Use `page` for multi-session / temporal questions where the answer depends on
the whole conversation. Use `window` when you only need local context.

With `return_unit: page`, `query` sizes its hit list to the budget so the
budget fills. Autocut stays off unless you set `autocut`, and a budget above
about 6,250 tokens raises the row count to one row per 250 tokens, up to 100.
An explicit `limit` or `autocut` still wins.

## Parameters and config

Per-call params on `search`, `query`, `recall`:

- `return_unit`: `chunk` | `window` | `section` | `page` | `auto`. Default from
  config `search.return_unit` (default `auto`).
- `search.long_page_unit` (config only, default `off`): `window` | `section` |
  `page` for long non-conversation hits under the implied `auto`; see
  [Long pages](#long-pages-searchlong_page_unit).
- `search.long_page_min_chars` (config only, default 20,000): the
  rendered-body length in characters at which a page counts as long for
  `search.long_page_unit`.
- `return_window`: integer 1–3, default from `search.return_window` (default 1).
  Used by `window` (and by the `section` fallback to `window`).
- Budget: `token_budget` on `search` / `query`, `budget_tokens` on `recall`.
  When no budget is given, `auto` uses `search.return_budget_conversation`
  (default 24,000: chat sessions run about 15K tokens, and at 16,000 some
  long sessions were still trimmed) and the other units use
  `search.return_budget_default` (default 6,000). Remote callers are clamped to
  `search.return_budget_max_remote` (default 32,000); the clamp is reported in
  `delivery.budget_clamped` and `delivery.fallbacks`, never raised per call.
  A trusted brain that needs more over stdio MCP (an eval cell's hermetic
  brain, for example) raises the ceiling once with
  `gbrain config set search.return_budget_max_remote 200000` and asserts that
  `delivery.budget_clamped` is absent; trusted local CLI calls are never
  clamped.
- An explicit budget under `auto` (`return_unit: "auto"`, or `auto` from config
  on `search`) is a hard cap, packed by `search.auto_packing` (see
  [Explicit budgets](#explicit-budgets-the-cap)); it must be at least 32 tokens.
- Legacy budget knobs keep their meaning: with `return_unit` omitted,
  `query`'s `token_budget` still prunes chunks (chunk mode), and `recall`'s
  `budget_tokens` / `budget_policy` still pack chunks (facts first), so any of
  them keeps an implied `auto` on `chunk`.
- `recall` with a unit and `budget_tokens` packs saved facts first (unless
  `budget_policy` is `query_first`). Delivery gets the budget the facts leave,
  and each delivered block costs what delivery counted (text and title, in
  `delivery.tokenizer`), so the facts and blocks together fill
  `budget_tokens` and no delivered block is dropped afterwards.
- Page-unit ranking cut (`search.page_rank_cut`, default `whole_pages`). A
  `return_unit: "page"` call that passes its own budget on `search`, `query`
  or `recall` lifts the search mode's chunk-token cut (`search.tokenBudget`:
  4,000 under conservative, none under tokenmax), and delivery walks the
  ranked pages, costing each at what it would deliver whole (text, title and
  date header in `delivery.tokenizer`, within the block char cap). It stops
  once they fill `search.page_rank_cut_factor` (default 1.5) × the budget the
  pages share; the page that crosses it stays only if its matching span still
  fits what the whole pages before it leave, and later pages are dropped as
  `rank_cut` (so a short page ranked after one that cannot be delivered even
  in part is not reached). Without the cut, a mode cut under-filled the budget
  on small pages, and tokenmax handed delivery more pages than it could
  deliver whole, so each arrived as a sliver. `delivery.page_rank_cut`
  reports `mode`, `factor`, `caller_budget`, `target`, `applied_cost` (the
  kept pages' whole cost), `candidates` and `kept`. A page call without a
  budget and every other unit are unchanged.
  `gbrain config set search.page_rank_cut off` restores the old path.
  Evidence: on 72 BEAM conversations the cut at 1.5 was non-inferior to the
  cut off (−0.25 points, lower bound −1.00 against a −3 margin) with
  delivered context at budget. Those conversations are regression evidence,
  not a held-out test, and 1.5 was picked under a rule amended after the dev
  results ([gbrain-evals #126, wave 2 results](https://github.com/garrytan/gbrain-evals/blob/8b764e3e/docs/benchmarks/2026-10-13-memory-proof-wave-2-results.md)).

Think reads `think.return_unit` (default `auto`) and never
`search.return_unit`, so changing search's default does not change `think`.
Under `auto`, think renders conversation pages whole and keeps its usual
excerpts for every other page.

### Date headers

With `search.evidence_date_header` on (default off), every delivered block,
including `auto`'s unchanged chunks, starts with one fixed line, and
`delivery.date_header` is `true`:

```text
[observed 2026-03-05]
```

`observed` is when the page's text was written or said: its filename or slug
date, frontmatter `date`, `published` or a created key, in effective-date
precedence with `event_date` removed. An event date (when something happened)
and the row's own timestamps are never shown as observed; a page without an
observation date reads `[observed unknown]`. A date stored at midnight UTC
renders as written, any other instant in `brain.timezone`. The header line
and its newline are part of `chunk_text`: they count in `delivered.tokens`,
`tokens_delivered` and the budget, `match_spans` offsets include them, and
`evidenceFingerprint` hashes them; under an explicit `auto` budget the cap pays for
them first and a cut keeps the header line whole. `recall` facts gain
`date_header: "[observed 2026-02-10; valid 2026-03-01 to unknown]"`. A fact's
`observed` date is the observation date of the page it came from
(`source_markdown_slug`, such as the conversation it was extracted from), and it
reads `unknown` for a fact kept only in its entity page's facts fence. `valid`
starts at the fact's `valid_from`: `remember` sets it from its `valid_from`
parameter (when the fact was said or became true). A `valid_from` that only
records the write time (within a minute of `created_at`) reads `unknown`, so a
header never presents when a fact was written as when it became true. An open
validity end reads `unknown`. The setting
applies to `search`, `query`, `recall`, `think` and `assemble_evidence`.

Config keys: `search.return_unit`, `search.return_window`,
`search.return_budget_default`, `search.return_budget_conversation`,
`search.return_budget_max_remote`, `search.evidence_date_header`, `search.auto_packing`,
`search.page_rank_cut`, `search.page_rank_cut_factor`, `think.return_unit`. Kill switch:
`gbrain config set search.return_unit chunk` and
`gbrain config set think.return_unit chunk` (or pass `return_unit: "chunk"`
per call).

### Conversation detection

`auto` decides per hit from fields every search row already carries, with no
extra query and no model call:

1. **Page type** is one of `conversation` (what `gbrain transcripts ingest` and
   the chat connectors write), `transcript`, `chat`, `meeting`, `slack`,
   `slack-dm-day`, `slack-thread`, `imessage` or `imessage-daily`
   (case-insensitive). Reason: `conversation_type`.
2. Otherwise the **slug** starts with `chat/` (chat imports and the LongMemEval
   adapter) or `conversations/` (the transcripts and connectors ingest
   directory). Reason: `conversation_slug`.
3. Anything else keeps its ranked chunk unchanged. Reason: `not_conversation`.

Pages the transcripts and connectors paths write carry both signals (type
`conversation` under `conversations/`), so their `transcript_import`
frontmatter is not read separately. Detection never looks at body text, so a
curated note that happens to quote a dialogue stays on the chunk path.

With no budget passed (the 24,000-token default), conversation hits share the
budget in rank order, after the unchanged chunks are paid for. Each
conversation page first reserves its matching span, then the pages grow toward
complete in rank order, so a lower-ranked session still keeps the part that
matched. A conversation whose matching span no longer fits keeps its ranked
chunks unchanged (reason `conversation_over_budget`), so `auto` without an
explicit budget never returns less than `chunk` would, and `budget_used`
exceeds `budget_tokens` only by such unchanged chunks. An explicit budget
changes this; see the next section.

### Long pages (`search.long_page_unit`)

Off by default. `gbrain config set search.long_page_unit section` (or `window`,
`page`; `off` turns it back off) makes `search` and `query` deliver a **long
non-conversation hit** in that unit under the implied `auto`, the way `auto`
already delivers conversations whole. Every other hit keeps its ranked chunk
unchanged. The value is a delivery unit from the table above and the unit
algorithms are the same; nothing selects passages by term overlap, so the
delivered unit is always the one around the ranked hit.

**Which unit applies.** One table decides, per call and hit:

| # | Source | When it applies | Unit |
|---|---|---|---|
| 1 | `return_unit` on the call | always (`auto` included: an explicit `auto` keeps every non-conversation chunk) | that unit |
| 2 | `search.return_unit` set to anything but `auto` | `return_unit` omitted | that unit, every hit |
| 3 | `search.long_page_unit` (not `off`) | `return_unit` omitted, `search.return_unit` unset or `auto`, no explicit `token_budget`, and the hit is a long non-conversation page | that unit (`delivered.reason: "long_page"`) |
| 4 | implied `auto` | everything else | conversations whole, other hits their ranked chunk |

The policy is resolved at the `search`/`query` caller and passed to the
assembler, so `recall`, `think` (`think.return_unit`) and `assemble_evidence`
never read the key and stay byte-identical with it on. `snippet_chars` does
not turn it off: a row widened by it (`delivered: {unit, reason: "long_page"}`)
is exempt from `snippet_chars` and comes back whole, because a head cut would
drop the tail the unit was widened to reach. The widened row still sits inside
`search.return_budget_conversation` and the long-page page and input-byte
limits below, and `snippet_chars` still cuts every other row, ranked chunks
included (those rows report `delivered: {truncated: true}`). The
`delivered.unit` and `reason` on the row are what tell the reader why it is
longer than `snippet_chars`. An explicit `token_budget` keeps it off because the cap (next section) keeps
its own rules, and `query`'s bare `token_budget` is chunk-mode budgeting anyway.
The subagent default snippet cap already keeps the implied `auto` on `chunk`.

**What is long.** A page whose rendered body (compiled truth plus timeline;
compiled truth only under `detail: "low"`) holds at least
`search.long_page_min_chars` characters (default **20,000**;
`gbrain config set` refuses anything but a positive whole number, and an
unusable stored value reads as the default). The size preflight compares the
stored body's character count; delivery confirms the threshold on the rendered
text (`pageEvidenceText`), and a page under it keeps its ranked chunk with no
fallback code. Conversation pages
(see [Conversation detection](#conversation-detection)) and saved-fact rows are
never long pages.

**Limits.** One size preflight query reads the character and byte counts of the hit pages
under the caller's read scope; it never reads a body. Then, in rank order, at
most **5** long pages (`LONG_PAGE_MAX_PAGES`) holding at most **1,000,000**
stored-body bytes together (`LONG_PAGE_MAX_INPUT_BYTES`) are fetched in one
bounded batched call of their own, so they can neither slow nor fail the
conversation fetch. A page that would cross a limit is skipped whole, never
sliced: bodies are sanitized whole before any cut. Preflight plus fetch share
a cooperative **2,000 ms** deadline (`LONG_PAGE_DEADLINE_MS`). A long page that
cannot be delivered in its unit keeps its ranked chunk, byte-identical to the
off path, with `delivered.reason: "long_page_chunk"` and a fallback code
saying why (below). A preflight that fails or misses the deadline leaves the
call on the off path.

**Budget.** Long pages are counted in the same delivery budget as
conversations (`search.return_budget_conversation`, default 24,000, clamped for
remote callers): unchanged chunks are paid for first, then conversations and
long pages reserve their matching span and grow in rank order. A long page
whose matching span no longer fits keeps its ranked chunk
(`long_page_chunk`, fallback `long_page_over_budget`), so the key never returns
less than `chunk` would.

**Response.** A long-page block is an ordinary delivered row (`delivered.unit`
is the unit that ran; a `section` with no structure falls back to `window`
with `no_section_structure`). Lean rows (the remote default) keep
`delivered: { unit, reason }` on both long-page reasons, plus `truncated: true`
when cut; every other lean row keeps only `{ truncated: true }`. A response
with no long page and no conversation is byte-identical to the key off.

### Explicit budgets (the cap)

When the caller passes a budget (`token_budget` on `query`, `search` and
`assemble_evidence`, `budget_tokens` on `recall`) and the unit is `auto`, the
budget is a hard cap on the delivered evidence: the recount of every result's
title plus `chunk_text` (the evidence, its omission lines, cut markers and
snippet markers) never exceeds it. JSON fields outside those two (`delivered`,
spans, scores, the `delivery` meta) are not counted. The four operations share
one rule:

1. **Rank one first.** The best-ranked hit, note or conversation, is reserved
   first. If it alone exceeds the budget it is cut at a piece boundary (a
   line, or a 400-character run of a long line) and ends with the cut marker
   `\n\n[…]`; it is never dropped.
2. **Notes get a prefix.** The other non-conversation chunks, in rank order,
   are kept while they fit; the first that does not fit and every one after
   it are dropped (`budget_note`). A lower-ranked note never crowds out a
   leading conversation.
3. **No spill.** A conversation that does not fit is dropped (`budget_floor`,
   or `breadth_cap` under `breadth_capped`), never appended outside the
   budget as chunks.
4. **The cap holds at the final boundary.** Secret redaction and an explicit
   `snippet_chars` run before the last recount. A snippet's recovery marker is
   paid from the row's own allocation (the body shrinks to make room, or the
   marker is left out with fallback `snippet_marker_omitted` when even it does
   not fit). A row that would still cross the budget is cut with the marker,
   or dropped as `budget_recount`. `budget_used` is that recount.

How conversations share what is left is `search.auto_packing`:

| Value | Conversations |
|---|---|
| `cap_only` (default) | Every conversation's matching span first, in rank order, then pages grow toward complete in rank order: the no-budget order, with the four rules above. |
| `breadth_capped` | Keeps the longest rank-order prefix of conversations whose title, matching span and target window (the `window` unit's neighbor chunks at `return_window`) all fit; the rest are dropped as `breadth_cap`. What is left grows those pages toward complete, in rank order. |
| `depth_first` | Takes conversations in rank order, each whole if it fits what is left, else as much around its matching span as fits; one whose matching span no longer fits is skipped, and later ones are still tried. |
| `off` | The no-budget behavior, even with an explicit budget (unchanged chunks paid first, conversations that do not fit spill as chunks, no minimum). |

`gbrain config set search.auto_packing <value>` refuses any other value.
`delivery.auto_packing` names the packing that ran; it is present only when
the cap engaged. The packing reads nothing but the plan, so `think` (which
passes no budget) and every call without a budget are byte-identical whatever
it is set to.

The smallest explicit `auto` budget is **32 tokens** (room for a cut marker, a
shortened title and a non-empty body). A smaller budget fails with
`invalid_params` naming the minimum, and so does a zero, negative or
non-finite one when the call passes `return_unit: "auto"` (with the unit
omitted such a budget still means no budget, as before). Above the minimum, a
non-empty, readable hit list always returns non-empty evidence. A remote
budget is clamped first (`search.return_budget_max_remote`), and the cap
applies to the clamped value.

`query`'s `token_budget` **without** `return_unit` still selects legacy chunk
budgeting (and `recall`'s `budget_tokens` / `budget_policy` legacy packing),
so a bare budget does not engage the cap.

### Precedence with `snippet_chars`

1. An explicit `snippet_chars` wins: delivered blocks are capped at that many
   characters (spans are clipped, `delivered.truncated` becomes true and
   `snippet_cap` is reported). The one exemption is a row widened by
   `search.long_page_unit` (`delivered.reason: "long_page"`): it comes back
   whole, within `search.return_budget_conversation` and the long-page limits.
2. Then an explicit `return_unit`: the subagent default snippet cap is skipped
   for its blocks.
3. Then the subagent default snippet cap (`agent.search_snippet_chars`, 300):
   when it applies, neither the implied `auto` nor a config-level
   `search.return_unit` expands.
4. Then `search.return_unit` from config, else `auto` (with `search.long_page_unit`
   for long non-conversation hits, whose widened rows are exempt from an
   explicit `snippet_chars`; see rule 1).

## Response shape (additive)

When a non-`chunk` unit is applied, each result's existing `chunk_text`
carries the delivered evidence (no duplicated body field), and each result
gains `delivered`. An implied `auto` with no conversation hit is not applied,
so those responses carry neither `delivered` nor `delivery`.

```jsonc
"delivered": {
  "unit": "page",                 // applied unit for this block: window | section | page | chunk (fallback)
  "chunk_ids": [812, 815],        // every ranked hit merged into this block, rank order (first = the result's own chunk_id)
  "match_spans": [                // where each hit chunk sits in chunk_text
    { "chunk_id": 812, "start": 0, "end": 1840 },
    { "chunk_id": 815, "start": 5210, "end": 6933 }
  ],
  "tokens": 2311,                 // tokens of chunk_text (delivery.tokenizer)
  "truncated": false,             // true when the unit was cut (budget, 60,000-char cap, fetch radius, snippet cap)
  "revision": "3f0c…",            // pages.knowledge_revision the text was read from
  "unmapped_chunk_ids": [],       // hits whose chunk is no longer in the current revision (present only when non-empty)
  "fallback_reason": "fetch_failed", // present only when the block fell back to the hit chunk text
  "reason": "conversation_type"     // auto only: conversation_type | conversation_slug | not_conversation | conversation_over_budget | saved_fact | long_page | long_page_chunk
}
```

Under `auto`, a `not_conversation` or `conversation_over_budget` result is the
ranked row unchanged (same `chunk_text`, including a code chunk's header line)
with `delivered: { unit: "chunk", chunk_ids: [its chunk_id], match_spans: [the
whole text], tokens, truncated: false, reason }`. Those rows are not grouped
by page. `gbrain search --explain` prints each result's unit and reason
(`evidence: page (conversation_type)`).

`match_spans` are **UTF-16 code-unit offsets** (JavaScript string indices) into
the returned `chunk_text`, computed after every text transformation (sanitizing,
cuts, omission lines and secret redaction). The text carries no inline markers.
A hit whose chunk cannot be located is listed in `unmapped_chunk_ids` instead.

One result is returned per expanded page, at the page's best rank. `chunk_id`,
`chunk_index`, `score` and the other ranking fields stay those of the page's
best-ranked hit (anchor provenance).

Response meta (`_meta.retrieval.delivery` over MCP; top-level `delivery` on
`recall`):

```jsonc
"delivery": {
  "requested_unit": "auto",
  "applied_unit": "auto",          // "chunk" when the stage could not run at all
  "return_window": 1,
  "budget_tokens": 6000,
  "budget_used": 5874,             // title + chunk_text tokens of every delivered block (≤ budget_tokens)
  "tokens_delivered": 5790,        // Σ delivered.tokens
  "tokenizer": "cl100k",           // "heuristic" when the encoder is unavailable
  "coordinates": "utf16",
  "blocks": 4,
  "dropped": 1,                    // hits/pages not delivered
  "dropped_reasons": { "budget_floor": 1 },
  "fallbacks": ["budget_clamped"], // distinct non-fatal problem codes, never silent
  "budget_clamped": { "requested": 50000, "max": 32000 },
  "date_header": true,             // only when search.evidence_date_header is on
  "auto_packing": "cap_only"       // explicit auto budgets only: the packing that ran
}
```

`recall` keeps its frozen v1 fields (`chunk`, `evidence`, char/4 packing via
`budget_tokens`); with a non-`chunk` unit its `results[].chunk` carries the
delivered text and each result gains `delivered`.

### Fallback and drop codes

| Code | Meaning | What the caller gets |
|---|---|---|
| `fetch_failed` / `fetch_timeout` | The neighbor fetch errored or exceeded 5 s. | The hit chunk (from this request's live retrieval), `fallback_reason` set. |
| `unsealed_page` | The page's chunks predate the protected-body index (`gbrain repair safe-chunks`). | The hit chunk, `fallback_reason` set. |
| `row_limit` | The request hit the budget-derived row cap before this page's rows. | The hit chunk, `fallback_reason` set. |
| `no_section_structure` | `section` found no headings or speaker turns. | A `window` block (`delivered.unit: "window"`). |
| `no_text_chunks` / `anchor_not_located` | No hit could be placed in the page text: no text chunk was in reach and the hit text itself was not found, or none of the located chunks overlap a hit. | The hit chunk (a code chunk without its synthesized header line), `fallback_reason` set. |
| `page_missing` | A hit carried no page id (cannot be re-authorized by id). | The hit chunk (live hits only), `fallback_reason` set. |
| `segment_read_failed` | A page stored in segments could not be read around its hits (its stored projection metadata was unusable, or a segment read failed). | The hit chunk (live hits only; cached hits are dropped as `not_readable`), `fallback_reason` set. |
| `redaction_unmapped` | Secret redaction changed a block. | Redacted block; its spans move to `unmapped_chunk_ids`. |
| `image_query_unsupported` | `query` with `image`: image hits are never expanded. | Plain image results; meta says so. |
| `snippet_cap` | An explicit `snippet_chars` cut a block. | Capped block, `truncated: true`. |
| `budget_clamped` | A remote budget above the max was clamped. | Clamped budget. |
| `tokenizer_heuristic` | cl100k unavailable; char/4 heuristic used. | Counts from the heuristic. |
| `date_header_unavailable` | Date headers are on but the page dates could not be read. | Every header reads `[observed unknown]`. |
| `long_page_pages` / `long_page_bytes` | `search.long_page_unit`: the long page came after 5 long pages, or would cross 1,000,000 stored-body bytes. | Its ranked chunk (`reason: long_page_chunk`). |
| `long_page_over_budget` | `search.long_page_unit`: the long page's matching span no longer fit the budget. | Its ranked chunk (`reason: long_page_chunk`). |
| `long_page_deadline` / `long_page_fetch_failed` / `long_page_preflight_failed` | `search.long_page_unit`: the size preflight or the long-page fetch missed the 2,000 ms deadline or failed. | Its ranked chunk (`reason: long_page_chunk`); a failed preflight leaves the call on the off path. |
| drop `not_readable` | The page is no longer readable by this caller (deleted, private, grant revoked, quarantined, archived source, source outside scope). | Result removed. Never falls back to cached text. |
| `snippet_marker_omitted` | Under an explicit `auto` budget, a row's allocation could not hold the snippet recovery marker. | Capped block without the marker, `truncated: true`. |
| drop `budget_floor` | Not even the block's matching span fits the remaining budget. | Result removed (rank one is instead cut to fit). Under `auto` without an explicit budget nothing is dropped for budget: the conversation keeps its ranked chunks. |
| drop `budget_note` | Explicit `auto` budget: a non-conversation chunk after rank one did not fit, or came after one that did not. | Result removed. |
| drop `breadth_cap` | `breadth_capped`: the conversation is past the prefix whose target windows fit. | Result removed. |
| drop `budget_recount` | Explicit `auto` budget: the final recount (after redaction and snippet markers) left no room for the row's title and a body. | Result removed. |

## Errors

An unknown `return_unit` or an out-of-range `return_window` fails with
`invalid_params`, naming the allowed values and an example call, e.g.

```
return_window must be an integer from 1 to 3 (got 7). Example: {"query": "launch date", "return_unit": "window", "return_window": 2}
```

An explicit `auto` budget below 32 tokens (or a zero, negative or non-finite
one passed with `return_unit: "auto"`) fails with `invalid_params`, e.g.

```
token_budget must be at least 32 tokens under return_unit auto (got 10): an explicit budget is a hard cap, and a smaller one cannot hold a title, a cut marker and any evidence.
```

A thin client talking to an older server that ignores `return_unit` prints one
warning naming the minimum server version.

## Guarantees

- **Authorization.** Every delivered block is re-read under the caller's
  current read scope (source scope, `visibility: private`, deleted,
  quarantined, archived sources, current text projection) in one batched query
  keyed by `page_id`, never by slug. A page that no longer passes is dropped.
- **Protected content.** Evidence text is cut from the page's stored body,
  sanitized WHOLE before any slicing with the same strict boundary the chunker
  uses (Takes fences removed, only world and not-withdrawn Facts rows kept,
  malformed or unterminated protected tails dropped, materialized markers
  stripped), `compiled_truth` and `timeline` each sanitized whole, then run
  through the credential-safe projection the chunkers also cut from: every
  private-key span (complete, or cut off at its `BEGIN` or `END` line) becomes
  `<REDACTED:private_key_pem>` followed by as many newlines as the span held,
  so line positions and chunk anchors stay aligned and no key material is
  delivered. This applies to every caller, including trusted local ones. Chunks only anchor the hits in
  that text, and the page must hold a sealed chunk index. Delivered text never
  contains anything `get_page` would not return to the same caller.
  `detail: "low"` never adds timeline text.
- **Frontmatter is not evidence.** Page frontmatter (YAML metadata) is never
  part of delivered text; `page` text is the sanitized body only.
- **Non-mutation.** The stage returns new result objects and never mutates or
  caches expanded text.
- **Bounded work.** One engine query per request (with `search.long_page_unit`
  on and a long page among the hits: plus one size preflight and one bounded
  long-page fetch, see [Long pages](#long-pages-searchlong_page_unit)). It reads each hit page's
  body once (bounded by the import size cap) plus the chunks within
  ±`return_window` of each hit; each block ≤ 60,000 characters (under the
  64 KiB output-redaction field limit).

## Algorithms (normative; E1 depends on them)

1. **Group.** Hits are grouped by `page_id` in rank order; the block takes the
   page's best rank. Fenced-code chunks (duplicates of page text) and image
   chunks never contribute neighbor text.
2. **Fetch.** One query returns each page's authorization, seal, stored body
   and the chunks within ±`return_window` of each hit (at most 1,024 rows).
3. **Page text and anchors.** The page text is
   `project(sanitize(compiled_truth))`, plus `\n\n<!-- timeline -->\n\n` +
   `project(sanitize(timeline))` when the
   timeline is non-empty after sanitizing and `detail` is not `low` (the join
   `serializeMarkdown` writes); `project` is `credentialSafeProjection`
   (`src/core/credential-projection.ts`), the function the markdown and code
   chunkers apply before splitting, so chunks and page text agree on every
   redacted key. Each fetched chunk is located in that text in
   `chunk_index` order: exact match first, then a whitespace-insensitive match
   (the chunker trims chunks and folds some whitespace-only runs, so chunk text
   is not always verbatim). A fenced-code hit is placed by its code without the
   code chunker's synthesized `[Lang] fence.ts:N-M symbol` header line (its
   `chunk_index` follows every prose chunk, so it carries no position; its
   window grows from the prose chunk holding the fence, when fetched). Fallback
   text for such a hit omits the header too, so delivered text is always page
   text. Overlapping chunks therefore never duplicate text:
   `page` evidence with an unlimited budget is byte-identical to the page text
   (trailing whitespace trimmed). Non-contiguous selections join with the
   omission line `\n\n[…]\n\n`.
4. **Units.** `section`: the nearest preceding ATX heading (outside fenced
   code) through the next heading of the same or higher level; unioned across
   hits. Conversation pages (≥ 4 speaker-turn lines such as `**user:**` /
   `**assistant:**`, `User:`, `Speaker 2:`, with ≥ 2 distinct labels and ≥ 3
   label changes; page `type` is ignored) use rounds: a round starts at each
   `user`/`human` turn (or the first label seen). `auto`: per hit, a
   conversation page (by type or slug, see
   [Conversation detection](#conversation-detection)) → `page`; anything else
   → its ranked chunk, unchanged and unbudgeted by this stage beyond its cost.
5. **Pieces.** The unit text is split into lines; lines over 400 characters
   split at whitespace. Token counts are the sum of per-piece cl100k counts
   (plus the omission line and the title), so the count is deterministic and
   CJK-correct.
6. **Allocate.** Budget `B` covers title + `chunk_text` of every block.
   *Reserve:* walk blocks by rank; each block's floor is its title plus the
   pieces covering its best hit; a block whose floor does not fit is dropped
   (`budget_floor`), later smaller blocks may still fit; if rank one alone
   exceeds `B` it is cut to fit (`truncated`). *Enrich:* walk kept blocks by
   rank; add pieces in priority order (other hits' pieces by hit rank, then by
   distance to the nearest hit piece, earlier position first on ties) until
   the unit is complete or the budget is spent. Selected pieces are emitted in
   document order; gaps become the omission line. The 60,000-character cap
   applies the same selection. Under an explicit `auto` budget the order is
   [Explicit budgets](#explicit-budgets-the-cap): rank one, the note prefix,
   then the packing's conversation rule; `breadth_capped` prices each
   conversation as title + matching span + its `window` candidates at
   `return_window` (pieces in priority order, omission lines counted) and
   keeps the longest prefix that fits.
7. **Redact.** Blocks pass through the same secret redaction as every search
   response before spans and tokens are computed.

## Latency (added by the stage)

`bun scripts/bench-evidence-delivery.ts --pages 10000 --iterations 200 [--postgres <url>]`
builds a synthetic brain (60% curated notes of 3–12 chunks, 30% conversation
sessions of 6–24 chunks, 5% 120-chunk pages, 5% CJK pages; sealed and
projection-current) and times `deliverEvidence` on ranked lists of 5 hits over
distinct random pages with a 6,000-token budget. Measured 2026-09-30 on a
4-vCPU / 15 GB cloud VM, Bun 1.3.14; PGLite in-memory; Postgres 16 + pgvector
in local Docker. Milliseconds.

| Engine | Unit | Cold | Warm p50 | Warm p95 | Large-page p95 | CJK p95 | 8 concurrent p95 | Rows / KB read per request |
|---|---|---|---|---|---|---|---|---|
| PGLite | window | 86.0 | 8.4 | 10.4 | 12.1 | 4.8 | 67.5 | 13.8 / 93.1 |
| PGLite | section | 8.6 | 7.8 | 9.6 | 14.9 | 4.8 | 66.0 | 13.6 / 87.6 |
| PGLite | page | 14.8 | 14.7 | 16.0 | 27.9 | 5.7 | 113.2 | 13.8 / 87.8 |
| PGLite | auto | 14.8 | 13.4 | 17.2 | 15.2 | 6.7 | 112.0 | 13.7 / 83.6 |
| Postgres | window | 176.7 | 8.3 | 11.8 | 12.8 | 5.3 | 64.2 | 13.8 / 93.1 |
| Postgres | section | 8.5 | 7.8 | 10.8 | 18.6 | 10.5 | 57.6 | 13.6 / 87.6 |
| Postgres | page | 17.0 | 15.5 | 22.6 | 26.6 | 7.3 | 108.7 | 13.8 / 87.8 |
| Postgres | auto | 15.4 | 13.3 | 16.5 | 14.7 | 5.6 | 104.8 | 13.7 / 83.6 |

Every unit stays under the 50 ms warm p95 target on the 10K-page brain. Every
request made exactly one engine call (no N+1); it reads the hit chunks and
each hit page's body once. The first call in a process pays a one-time cl100k
encoder load and query planning (the "cold" window row). Tails are noisy on a
shared VM: an earlier PGLite run with another process busy measured 56.5 ms
large-page p95 for `page` and 34.8 ms warm p95 for `auto`. Under 8
concurrent requests each request waits for the others' JavaScript work
(sanitizing, chunk location and token counting run on the single event loop), so per-request
p95 grows to about 8 × the warm cost while throughput stays the same.

## Frozen-candidate interface (gbrain-evals, E1/E3 parity)

Evaluations must measure the code that ships. Two entry points produce, for an
ordered hit list, **exactly** the evidence the `query` op would return:

### Library (trusted local, in-process)

```ts
import { assembleEvidenceForHits, evidenceFingerprint } from 'gbrain/search/evidence-delivery';

const out = await assembleEvidenceForHits(engine, {
  hits: [ { source_id: 'default', slug: 'chat/session-0412', chunk_id: 8812 }, /* rank order */ ],
  return_unit: 'page',        // chunk | window | section | page | auto (the product default)
  return_window: 1,           // optional
  budget_tokens: 6000,        // optional; same default/clamp rules as query (explicit: the cap under auto)
  detail: 'medium',           // optional, as query
  caller: { remote: false },  // optional; { remote: true, sourceIds: [...] } emulates a remote caller
  auto_packing: 'breadth_capped', // optional, library only: wins over search.auto_packing for this call
});
// out.results  — the redacted result array (JSON-serializable), same objects the query op returns
//                for these hits: { slug, source_id, page_id, title, type, chunk_id, chunk_index,
//                chunk_source, chunk_text, effective_date, effective_date_source, delivered, ... }
// out.delivery — the delivery meta block
// out.unresolved — hits that could not be resolved in the caller's scope (dropped)
const fp = evidenceFingerprint(out.results); // sha256 hex
```

Each result carries the page's `effective_date` (`YYYY-MM-DD`) and
`effective_date_source` exactly as the live `query` row does, `null` for a
page without a date, so a frozen delivery hands a reader the same dates.
`auto_packing` exists only on the library call (never an MCP parameter), so an
evaluation can compare packings on one frozen hit list without switching the
brain's config between calls.

`chunk_id: 0` addresses the page's first chunk (the synthetic rows exact-slug
and alias hits carry). Hits outside the caller's scope, deleted pages and
unknown chunk ids are dropped and listed in `unresolved` (by input index).

### Op `assemble_evidence` (any transport: local CLI, MCP stdio, HTTP)

Read scope. Params: `hits` (array of `{ source_id, slug, chunk_id }`, rank
order, max 50), `return_unit` (default `page`; pass `auto` to measure the product default), `return_window`, `token_budget`,
`detail`. Returns `{ results, delivery, unresolved }` with the same content as
the library call for that caller. Remote callers get the same filtering as
`query` (private pages hidden, sealed pages only, grants enforced).

### Fingerprint

`evidenceFingerprint(results)` is the SHA-256 (hex) of
`JSON.stringify(results.map(r => [r.source_id ?? 'default', r.slug, r.chunk_text, r.delivered?.unit ?? 'chunk', r.delivered?.chunk_ids ?? [r.chunk_id]]))`.
It is identical for the `query` op's results and for `assemble_evidence` /
`assembleEvidenceForHits` given the same ordered hits, unit, window, budget and
caller class, on both engines. `test/e2e/evidence-delivery-parity.test.ts` pins
this.

### Parity recipe for E3

1. Run `query` with `return_unit: "chunk"` and **no** `token_budget` to get the
   ranked hits (or use the frozen list). With a non-`chunk` unit, `token_budget`
   budgets the delivered evidence instead of pruning chunks, so the ranked list
   the stage sees equals the chunk-mode list without a budget.
2. Run `assemble_evidence` with those hits and the policy, and `query` with
   the same policy and budget.
3. Fingerprints must match; any difference means the product path does not
   deliver the evidence the experiment assumed.

For the default, compare `query` with `return_unit` **omitted** (and no
`token_budget`, which would keep the legacy chunk budget) against
`assemble_evidence` with `return_unit: "auto"`. When no hit is a conversation
the default returns plain rows; their fingerprint equals the `auto` one.

Always pass `expand: false` to `query` for E3. `query` otherwise runs LLM
multi-query expansion by default, which can change the ranked list from run to
run (retrieval drift, not a delivery difference). `assemble_evidence` does no
retrieval at all, so it is deterministic for a given hit list, page revision,
unit, window and budget.
