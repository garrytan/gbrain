# Explaining search results

`query` (and the CLI `gbrain search`) explain their own ranking. With `explain: true` every
returned row carries `score_details`: which retrieval arms found it and at
what rank, how fusion scored it, and every boost or demotion applied after
fusion. With `explain_target` the response says what happened to a page you
expected but did not get, and what to do next.

**Say to your agent:**
- *"Why is this page ranked first for my question?"*
- *"I know there is a note about the acme-example renewal — why didn't search find it?"*
- *"Show me how the search scored these results."*

## Explain a result list

MCP:

```json
{ "tool": "query", "arguments": { "query": "acme-example renewal terms", "expand": false, "explain": true } }
```

CLI:

```bash
gbrain search "acme-example renewal terms" --explain          # readable breakdown
gbrain search "acme-example renewal terms" --explain --json   # the same score_details per row
```

Each row's `score_details`:

| Field | Meaning |
|---|---|
| `arms` | One entry per retrieval arm instance that returned the row: `vector`, `vector_variant#N`, `vector_clause#N`, `image`, `keyword`, `title`, `relational`. `rank` is 1-based; `fusion_rank` is the 0-based rank fusion used; `contribution` = `weight / (k + fusion_rank)`. `vote: "page"` means the vote counts for the whole page (carried by its lead chunk). |
| `rrf` | `raw` (summed votes), `normalized` (divided by the best row), `compiled_truth_boost`. `state: "not_run"` on single-arm paths. |
| `blend` | The cosine blend: `0.7 × norm_rrf + 0.3 × cosine`. `not_run` without a query embedding. |
| `base_score` | The score entering the post-fusion boosts. |
| `boosts` | Every factor that changed this row, by stage: `backlink` (with its `inbound` links), `salience`, `recency`, `chronicle`, `title`, `adjacency`, `cross_source`, `session_demote`, `alias_resolved`, `supersede`, `exact_match`. |
| `rerank` | Cross-encoder score and rank delta, or `not_run`. |
| `final` | The row's score. |

A stage the search did not run is reported as `not_run` or `skipped` with a
reason, never as an invented value.

## See where the time went

Every `search` and `query` response carries its stage timings in
`_meta.retrieval.timings` (MCP and thin clients; never in the result text),
and `gbrain search --explain` / `gbrain query --explain` print them as the
first header line, on empty and degraded responses too:

```text
timings: 74ms total — setup 1, lexical 12, relational 0, embed 0, vector 16, fuse 26, post_fusion 9, rerank 2, alias_fanout 0, anchoring 0, facts_arm 5, response 3, other 0 (overlapped: keyword_arm 12, title_arm 12)
```

**Say to your agent:** *"Why was that search slow? Show me where the time went."*

| Field | Meaning |
|---|---|
| `total_ms` | Wall time of the whole operation, measured on its own clock after the response is assembled. |
| `stages_ms` | Time the request spent blocked in each stage that ran: `setup` (scope, config, mode), `lexical`, `relational`, `expansion`, `embed`, `vector`, `fuse`, `post_fusion` (boosts, dedup, identity tiers, return sizing), `rerank`, `alias_fanout`, `anchoring`, `facts_arm` (query), `response` (evidence delivery, response metadata, redaction). A second search the operation runs (a retry, a CRAG re-run) adds to the same stages; the alias fan-out's keyword searches count under `alias_fanout`. |
| `other_ms` | Time no stage claimed. `sum(stages_ms) + other_ms = total_ms`. |
| `overlapped_ms` | Work that ran alongside a stage, so it is not added to the total: the keyword and title arms run in parallel inside `lexical` (`keyword_arm`, `title_arm`), `search`'s total-match count runs alongside the whole request (`keyword_count`), and the vector side (query expansion, the query embed and the vector search) starts with the lexical arms, so the part of `expansion`, `embed` and `vector` that finished while they ran is listed here under the stage's name. The rest of those stages, the part the request had to wait for, stays in `stages_ms`. The response metadata's concurrent reads are listed as `meta_saved_facts`, `meta_entity_facts`, `meta_held`, `meta_readiness`, `meta_freshness`, `meta_embedding_held`, `meta_safe_index` and `meta_filter_hint`; `response.meta` waits for the slowest of them. |
| `parts_ms` | Present when a stage records its steps: `response` splits into `evidence` (evidence delivery), `trust` (the page-trust stamp), `meta` (the response metadata), `keyword_count` (the wait for `search`'s total-match count) and `feedback` (the answer-feedback record). Parts run one after another and never overlap, so they sum to at most the stage; the rest of `response` is redaction, snippet caps and row projection. `stages_ms.response` keeps its whole time. |

All values are integer milliseconds.

### The whole CLI call and what it spent

`gbrain search --json --timings` and `gbrain query --json --timings` print
`{ "results": [...], "timings_ms": {...}, "cost": {...} }` instead of the bare
result array (plain `--json` is unchanged); without `--json`, `--timings`
adds one `timings:` line on stderr.

`timings_ms` adds the CLI's own phases to the operation's stages: `total`
(process start to output), `startup` (module load, config, argument parsing),
`connect` (opening the brain), `context` (operation context and source
resolution), `remote` (a thin client's round trip to its server), `op` (the
operation's `total_ms`), `stages` (its `stages_ms` plus `other`),
`overlapped`, `parts` (the operation's `parts_ms`) and `cli_other` (CLI time in no phase: formatting, notices). A
phase that did not run is absent; `0` means it took under half a
millisecond. On a thin client `op` and `stages` are the server's.

`cost` (also `_meta.retrieval.cost` over MCP) counts every model call the
request made, by kind (`embedding`, `rerank`, `expansion`, `chat`, `decide`;
`expansion` is the same call `chat_usage_log` records with phase `expansion`), each with
`calls`, `input_tokens`, `output_tokens` and `usd`, plus `calls` and
`estimated_usd` in total. Tokens are what the provider reported; a call it
reported none for counts its request estimate and is tallied in
`estimated_token_calls`. `usd` comes from the shipped price tables and is
left out when a model is not priced. Failed calls count (a provider can bill
them); a call a budget guard refused was never sent and does not. A
keyword-only search reads `{ "calls": 0, "estimated_usd": 0 }`.

## Diagnose a missing page

MCP:

```json
{ "tool": "query", "arguments": { "query": "acme-example renewal terms", "expand": false, "explain_target": "meetings/2026-03-02-acme-example" } }
```

The response meta `explain_target` holds the diagnosis, and a notice carries
the next step:

| `code` | What happened | Next step |
|---|---|---|
| `target_returned` | The page is in the results at `rank`. | Read its `score_details`. |
| `target_beyond_limit` | It ranked below the requested limit. | The notice repeats the search with a limit that reaches it. |
| `target_dropped_dedup` | Dedup kept a higher-ranked row from the same page or a near-duplicate. | Read the page directly with `get_page`. |
| `target_dropped_return_sizing` | Autocut or adaptive return trimmed it. | `get_page`, or repeat with `autocut: false` (query). |
| `target_dropped_token_budget` | The evidence budget filled first. | Repeat with a larger `token_budget`. |
| `target_dropped_relaxed_keyword` | Only a loose keyword match found it. | `get_page`, or rephrase with the page's own terms. |
| `target_not_retrieved` | No arm returned it for this query. | `query --expand` (`expand: true`; one call to the configured expansion model) or rephrase. |
| `target_not_indexed` | The page has no indexed chunks. | `gbrain doctor --json` names the re-index command. |
| `target_projection_stale` | The page changed and its searchable text is still being rebuilt. | Retry after `gbrain doctor` shows the backlog drained. |
| `target_safe_chunks_uncertified` | Remote reads withhold pages indexed before the current safe-chunk format. | The brain host runs `gbrain repair safe-chunks`. |
| `target_ambiguous` | The slug exists in several sources. | Repeat with `explain_target` as `source:slug`. |
| `target_not_found_or_not_visible` | No page with that slug is readable here. | Ask the user whether it exists and where; private pages are never confirmed. |

Both params are declared on `query` on the full MCP tool surface; the cheap
`search` tool and the starter list stay lean because every declared param is
re-sent to the model on each turn. A starter-surface session calls
`request_tools {"surface": "full"}` first. Agents on the default seven-verb
memory surface do not have `query`; ask the brain host to run
`gbrain search "<question>" --explain --json`, or enable the full tool surface.
