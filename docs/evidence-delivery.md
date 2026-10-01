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

**Say to your agent:** *"Search my brain for what alice-example said about the
launch date, and read the whole conversation, not just the snippet."*

**Say to your agent:** *"Find every session where we discussed the acme-example
renewal and give me the full sessions within about 6,000 tokens."*

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

## Parameters and config

Per-call params on `search`, `query`, `recall`:

- `return_unit`: `chunk` | `window` | `section` | `page` | `auto`. Default from
  config `search.return_unit` (default `auto`).
- `return_window`: integer 1–3, default from `search.return_window` (default 1).
  Used by `window` (and by the `section` fallback to `window`).
- Budget: `token_budget` on `search` / `query`, `budget_tokens` on `recall`.
  When no budget is given, `auto` uses `search.return_budget_conversation`
  (default 24,000: chat sessions run about 15K tokens, and at 16,000 some
  long sessions were still trimmed) and the other units use
  `search.return_budget_default` (default 6,000). Remote callers are clamped to
  `search.return_budget_max_remote` (default 32,000); the clamp is reported in
  `delivery.budget_clamped` and `delivery.fallbacks`, never raised.
- Legacy budget knobs keep their meaning: with `return_unit` omitted,
  `query`'s `token_budget` still prunes chunks (chunk mode), and `recall`'s
  `budget_tokens` / `budget_policy` still pack chunks (facts first), so any of
  them keeps an implied `auto` on `chunk`.

Think reads `think.return_unit` (default `auto`) and never
`search.return_unit`, so changing search's default does not change `think`.
Under `auto`, think renders conversation pages whole and keeps its usual
excerpts for every other page.

Config keys: `search.return_unit`, `search.return_window`,
`search.return_budget_default`, `search.return_budget_conversation`,
`search.return_budget_max_remote`, `think.return_unit`. Kill switch:
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

Conversation hits share the budget in rank order, after the unchanged chunks
are paid for. Each conversation page first reserves its matching span, then
the pages grow toward complete in rank order, so a lower-ranked session still
keeps the part that matched. A conversation whose matching span no longer
fits keeps its ranked chunks unchanged (reason `conversation_over_budget`), so
`auto` never returns less than `chunk` would. `budget_used` exceeds
`budget_tokens` only by such unchanged chunks.

### Precedence with `snippet_chars`

1. An explicit `snippet_chars` wins: delivered blocks are capped at that many
   characters (spans are clipped, `delivered.truncated` becomes true and
   `snippet_cap` is reported).
2. Then an explicit `return_unit`: the subagent default snippet cap is skipped
   for its blocks.
3. Then the subagent default snippet cap (`agent.search_snippet_chars`, 300):
   when it applies, neither the implied `auto` nor a config-level
   `search.return_unit` expands.
4. Then `search.return_unit` from config, else `auto`.

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
  "reason": "conversation_type"     // auto only: conversation_type | conversation_slug | not_conversation | conversation_over_budget
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
  "budget_clamped": { "requested": 50000, "max": 32000 }
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
| `redaction_unmapped` | Secret redaction changed a block. | Redacted block; its spans move to `unmapped_chunk_ids`. |
| `image_query_unsupported` | `query` with `image`: image hits are never expanded. | Plain image results; meta says so. |
| `snippet_cap` | An explicit `snippet_chars` cut a block. | Capped block, `truncated: true`. |
| `budget_clamped` | A remote budget above the max was clamped. | Clamped budget. |
| `tokenizer_heuristic` | cl100k unavailable; char/4 heuristic used. | Counts from the heuristic. |
| drop `not_readable` | The page is no longer readable by this caller (deleted, private, grant revoked, quarantined, archived source, source outside scope). | Result removed. Never falls back to cached text. |
| drop `budget_floor` | Not even the block's matching span fits the remaining budget. | Result removed (rank one is instead cut to fit). Under `auto` nothing is dropped for budget: the conversation keeps its ranked chunks. |

## Errors

An unknown `return_unit` or an out-of-range `return_window` fails with
`invalid_params`, naming the allowed values and an example call, e.g.

```
return_window must be an integer from 1 to 3 (got 7). Example: {"query": "launch date", "return_unit": "window", "return_window": 2}
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
  stripped), `compiled_truth` and `timeline` each sanitized whole. This applies
  to every caller, including trusted local ones. Chunks only anchor the hits in
  that text, and the page must hold a sealed chunk index. Delivered text never
  contains anything `get_page` would not return to the same caller.
  `detail: "low"` never adds timeline text.
- **Frontmatter is not evidence.** Page frontmatter (YAML metadata) is never
  part of delivered text; `page` text is the sanitized body only.
- **Non-mutation.** The stage returns new result objects and never mutates or
  caches expanded text.
- **Bounded work.** One engine query per request. It reads each hit page's
  body once (bounded by the import size cap) plus the chunks within
  ±`return_window` of each hit; each block ≤ 60,000 characters (under the
  64 KiB output-redaction field limit).

## Algorithms (normative; E1 depends on them)

1. **Group.** Hits are grouped by `page_id` in rank order; the block takes the
   page's best rank. Fenced-code chunks (duplicates of page text) and image
   chunks never contribute neighbor text.
2. **Fetch.** One query returns each page's authorization, seal, stored body
   and the chunks within ±`return_window` of each hit (at most 1,024 rows).
3. **Page text and anchors.** The page text is `sanitize(compiled_truth)`,
   plus `\n\n<!-- timeline -->\n\n` + `sanitize(timeline)` when the
   timeline is non-empty after sanitizing and `detail` is not `low` (the join
   `serializeMarkdown` writes). Each fetched chunk is located in that text in
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
   applies the same selection.
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
  budget_tokens: 6000,        // optional; same default/clamp rules as query
  detail: 'medium',           // optional, as query
  caller: { remote: false },  // optional; { remote: true, sourceIds: [...] } emulates a remote caller
});
// out.results  — the redacted result array (JSON-serializable), same objects the query op returns
//                for these hits: { slug, source_id, page_id, title, type, chunk_id, chunk_index,
//                chunk_source, chunk_text, delivered, ... }
// out.delivery — the delivery meta block
// out.unresolved — hits that could not be resolved in the caller's scope (dropped)
const fp = evidenceFingerprint(out.results); // sha256 hex
```

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
