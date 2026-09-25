# Released T-Mem diagnostic, frozen before inference

**Historical protocol:** the experiment is complete; see the [postmortem](postmortem.md) and [results](results.md). The original protocol is preserved below, including its future-tense execution rules. This is not authorization for another run. The unmodified copy inside the [reproduction bundle](tmem-reproduction-results.tar.gz) has SHA-256 `3aa924914c55b9a40d85bdbdd8081f80dfdb086013323118cb9b750a8f932938`.

This is a reproduction of released code at `dd9e1527bc75908485809580c9520af5a9a42879`, not a faithful replication of paper Table 4. The documented Plus route omits the paper's hierarchical items/persona/reranker and constructs memory with access to the query. The independent methods audit records exact source references and further limitations. No inference or outcome was available when this protocol was selected.

## Locked comparison

- Twenty original Cognitive sample indices: `9,27,47,54,58,116,128,148,160,166,214,215,244,265,294,301,302,349,367,398`. Five per relation, selected by ascending SHA-256 of `tmem-table4-pilot-v1:{original_index}` within each relation. Do not change selection based on results.
- Base conversation remains original index modulo ten. Preserve original sample IDs and supply the pinned full 401-row evidence list to the judge.
- Pin `locomo10.json` to SHA-256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` and `locomo_plus.json` to `af2fc6e5e0e88735e28d8dd1ef474b718861a73beb21779809e3b9e1a4fe3d23`.
- Construct each query-conditioned library once with original stage 0/1 and stage 4 functions and prompts. Preserve lexicographic session ordering and upstream scene UUIDs. Share scenes, triggers, query embeddings and per-channel scores across arms. Do not construct unused graph/persona artifacts for this scene-only route.
- Full arm: raw-dialogue + Scene + Horizon RRF rank lists. No-Horizon arm: raw-dialogue + Scene. No-Scene/Horizon arm: raw-dialogue only. RRF k=30, identical candidate universe, scene-ID tie break and top ten scene summaries. Disabled rank lists contribute nothing.
- Use GPT-4.1-mini construction, BGE-M3 embeddings, GPT-4o reading, Gemini-2.5-Flash judging. Preserve the released reader and judge prompts, temperature zero, and one judgment per prediction. Transport aliases and exact served providers/model responses must be recorded. No model substitutions.
- Each arm gets isolated prediction and judge outputs. Interleave arms deterministically and hide arm names from judge inputs. Do not reuse weak upstream resume caches between arms.

## Execution and claims

Run the lowest original selected ID first as a plumbing check, without treating its outcome as a reason to retain or drop it. After verifying complete artifacts and actual request routing, continue the other nineteen under the same protocol. Infrastructure repair must not alter retrieval or prompt semantics; any substantive protocol change gets a new labeled run.

Primary outcome: released judge's memory-awareness accuracy over all twenty selected units per arm, with paired full-minus-no-Horizon and full-minus-no-Scene/Horizon wins, losses, ties and absolute differences. Report per-relation results and all failures. Do not present this balanced small sample as the full 401-row score. Missing or incomplete construction cannot be scored as a successful retrieval run or silently omitted.

Secondary diagnostics: actual selected scene IDs, per-channel rankings, cue provenance and reader context. These explain gains or losses but do not replace the primary outcome. Query-free construction and a reconstructed paper-settings cascade are separate follow-ups, not hidden corrections to this run.

Root alone authorizes and executes paid requests. All endpoints pass through a loopback-only, append-only metered gateway with pre-dispatch reservations, bounded native output lengths, a finite deadline, request/response journals and no automatic provider fallback. Unknown charges retain their reservation. Preserve the previous custom-run ledger and failures unchanged. A new allocation is recorded before any provider smoke or experiment dispatch.

## Verified transport and execution details

The four model endpoints passed a four-request compatibility check before any benchmark inference. BGE-M3 returned 1024-dimensional embeddings from DeepInfra; construction and reader requests were served by OpenAI; the judge was served by Google AI Studio. The check cost $0.000071326 in reported router plus external BYOK charges. It is not an evaluation result.

Routes are pinned without fallback: `openai/gpt-4.1-mini` via `openai`, `openai/gpt-4o` via `openai`, `google/gemini-2.5-flash` via `google-ai-studio`, and `baai/bge-m3` via `deepinfra/fp32`. The gateway maps released aliases without modifying prompts. It explicitly transmits each chat endpoint's published native output maximum (32768, 16384, 65535 respectively); the released client otherwise transmits no maximum. Responses ending at the length limit must be disclosed. Endpoint catalogs and actual response model/provider fields are retained; original paper serving revisions are unknown.

The gateway holds an exclusive process lock before replaying its ledger, preserves unknown reservations across restarts, and counts OpenRouter fees plus upstream inference charges when `is_byok=true`. It does not count upstream costs twice on ordinary non-BYOK routes. Worker processes receive only dummy loopback API credentials, with real provider keys removed from their environment. Construction may run libraries concurrently using the released global concurrency setting, but each history remains sequential.

Root inspected all four historical revisions that changed the released Plus shell runner after fetching full Git history. All use stage 5 directly into stage 8; no alternative hierarchical Plus runner was recovered from those script revisions. The public repository has one branch, no tags and no issues at inspection time. These checks narrow the reproducibility gap but do not prove unpublished author artifacts do not exist.
