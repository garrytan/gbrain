# MCP `_meta` channels

Normative conventions for `ToolResult._meta` on gbrain's MCP surfaces.
`_meta` is the structured, out-of-band
channel for tool-call responses; the response BODY contract never changes
shape for it.

## Rules

1. **One producer per top-level key.** A producer owns exactly one
   namespaced key and never writes another producer's key. The dispatch
   layer (`src/mcp/dispatch.ts`) merges per top-level key — never wholesale
   `_meta` assignment.
2. **Additive-forever within a key.** Fields inside a key may be added,
   never renamed or removed — the RESPONSE_SCHEMAS discipline applied to
   `_meta`. Consumers must tolerate unknown fields.
3. **Producer isolation.** Every producer attaches inside its own
   try/catch. A failing producer degrades to its key being absent; it never
   drops another producer's key and never errors the tool call.
4. **Merge precedence.** Handler-emitted keys (via
   `OperationContext.emitResponseMeta`) attach first; transport hooks
   (`metaHook`) attach after and may add keys but shadow nothing that
   matters — key ownership (rule 1) makes ordering a non-event.
5. **Model visibility caveat.** Mainstream harnesses do NOT feed `_meta` to
   the model. Anything the model must SEE rides a content block (see the
   second text block on empty retrievals); `_meta` serves structured
   programmatic consumers (thin clients, harness plumbing, tests).

## Registered keys

| Key | Producer | Contents |
|-----|----------|----------|
| `brain_hot_memory` | serve-http `metaHook` (`getBrainHotMemoryMeta`) | Hot-memory facts relevant to the call; each fact carries `trust_tier` and `origin`, and `suppressed` (`{withheld, review}`, present only when non-zero) counts unconfirmed agent-written facts activation control withheld, never their content |
| `degraded` | dispatch (`src/core/degraded-stamp.ts`), on every transport | `{reasons: [...]}`: present only when the result is partial or degraded; sorted, unique stable codes ([AGENT_OPERATOR_v1.md, Degraded stamp](AGENT_OPERATOR_v1.md#degraded-stamp)). Mirrored as the last content block, `[gbrain degraded: <codes>] …` |
| `retrieval` | `search`/`query` op handlers; `recall` and `find_experts` emit `{degraded[]}` when their page search degraded | `returned_count`, `retrieved_count`, `vector_enabled`, `expansion_applied`, `cache`, `token_budget`, `degraded[]` (closed stage vocabulary), `rerank_degraded` (on a call whose reranker failed: `{reason, fallback: "fused_order", calls_this_session}`; reason is `timeout`, `budget`, `rate_limited`, `unreachable`, `auth` or `provider_error`; no `fields: "full"` needed), `hint` (non-contractual prose), `rows` (`"lean"` or `"full"`: the row shape of content[0]; reported for remote callers and whenever `fields` is passed), `timings` (`{total_ms, stages_ms, other_ms, overlapped_ms?, parts_ms?}`, integer ms, every response; [search-explain.md](../guides/search-explain.md#see-where-the-time-went)) |
| `warnings` | dispatch strict-params warn mode | `[{code: 'unknown_param', param, suggestion?}]` |
| `pagination` | `list_pages` op handler | `truncated` (more rows match), `limit` (effective), `clamped_from?` (the caller's limit when capped), `next?` (params for the following page: `{sort, updated_after, updated_after_slug}` under `updated_asc`, else `{offset}`). The model-visible counterpart is the `listing_truncated` notice block (kind `info`, never deduped), whose `fix.mcp` is the next-page call. |

Inbound `_meta` (e.g. `_meta.session_id` inside tool ARGUMENTS) is a
separate, client-to-server plane. The eval-report `_meta.metric_glossary`
lives in JSON BODIES of eval commands — a third, unrelated plane. Ambient
recall rides content/hooks, not `_meta`.

Adding a key: register it in the table above, one producer, additive-forever.

## Degraded stamp codes

The codes in `_meta.degraded.reasons` ([AGENT_OPERATOR_v1.md, Degraded stamp](AGENT_OPERATOR_v1.md#degraded-stamp)). The list grows; a code never changes meaning.

| Code | Ops | Meaning |
|---|---|---|
| a retrieval stage: `embed_unavailable`, `embed_timeout`, `expansion_failed`, `expansion_partial`, `rescore_skipped`, `vector_arm_failed`, `keyword_arm_failed`, `title_arm_failed`, `budget_dropped_all`, `budget_truncated`, `keyword_zero`, `cache_prestamp`, `rerank_passthrough`, `rerank_failed`, `keyword_relaxed_carried`, `safe_index_pending`, `vector_candidates_incomplete`, `keyword_candidates_incomplete`, `projection_pending`, `projection_by_design`, `projection_status_unknown`, `keyword_count_unavailable` | search, query, recall, find_experts; think and synthesize (their page search) | the stage in `_meta.retrieval.degraded` (every stage except the ranking-only `reranker_skipped`; `projection_pending` only when a pending page could match). `embed_unavailable` also covers a keyless brain and recall's keyword-only markers, so a keyless brain stamps every search |
| `no_query_terms`, `facts_embedding_column_missing`, `facts_read_failed` | recall | `facts_degraded.reason` of a question-ranked recall |
| `facts_unembedded` | recall | some facts in scope could not be compared with the question |
| `deadline`, `server_budget`, `budget_trimmed` | context_pack | `degraded_reason`: the pack is partial |
| `delta_incomplete` | delta | delta delivered less than is waiting |
| `file_held` | get_page | the page's newer file is held by sync; this is its last good revision |
| `gather_hybrid_failed`, `gather_takes_keyword_failed`, `gather_takes_vector_failed`, `gather_graph_failed`, `gather_anchor_hydrate_failed`, `gather_window_floor_failed` | think, synthesize | an evidence stream failed (the matching `GATHER_*_FAILED` warning) |
| `held_files`, `sources_not_readable`, `references_unavailable`, `mention_index`, `relational_chain`, `graph_walk_truncated`, `pinned_answer_stale` | the ops that emit the notice of that code | a `kind: degraded` notice about this result |
| `scan_deadline`, `unreadable_pages` | search_exact | `incomplete_reasons` other than the caller's `limit` |
| `source_stale`, `held_items` | open_loops | `stale` or `completeness: "partial"` |
| `link_coverage_behind`, `link_coverage_unread` | rank_entities | `coverage.state` |
