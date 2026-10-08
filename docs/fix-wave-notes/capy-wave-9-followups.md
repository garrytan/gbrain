# Wave 9 follow-ups notes (`capy/wave-9-followups`, v0.60.107.0)

One integrated PR for the nine follow-ups fix wave 9 (v0.60.74.0) filed in
TODOS. Three lanes were built in parallel on master v0.60.99.0 and merged here
onto master v0.60.106.0 (after fix waves 10, 11 and 12 and the four #6188
fence PRs):

- **Lane R+F:** receipted managed writes for conversation facts (batched),
  fence facts, deleted-page expiry, takes reextract and take reprojection, the
  receipt coverage table, the 80% admission stop, and
  `gbrain repair conversation-labels` (items 1 and 2).
- **Lane T:** concept file recheck, take row reservation, shutdown errors,
  supervisor stop, `takes rebuild` under serve (items 3, 4, 6, 7, 8).
- **Lane J:** the judge thinking capability table and judge cost preflights
  (item 5). Item 9 (stall detection) is deferred to TODOS.

Decisions as approved: 1A defer stall detection, 2A one PR, 3A visible
reservation row, 4A expire (not delete), 5A 1970-01-01 facts by default,
6A one capped live probe, 7A only `UnrecoverableError` burns an attempt during
shutdown, 8A stamp the extractor version and count stale outcomes in doctor,
9 batched receipts (about 25 pages or 8 MiB per request, fact pages in smaller
batches, no migration, plus an 80% stop), 10A enforce receipts in tests and
the coverage table only.

## Integration with master

- `fence-repair/llm.ts` (#6188 PR4) used `thinkingOffNamespace`, which lane J
  replaced with the capability table: its Tier 3 ceiling now reserves room to
  reason only where the route's thinking-off option does not turn reasoning
  fully off (Gemini 2.5 Flash, which now sends `thinkingBudget: 0`, gets the
  table's size). Lane J gave gpt-6 the 32,000-token headroom; that reserved
  $0.32 per page for fence repair's measured default `openai:gpt-6.1-sol`,
  over its $0.30 per-page cap, so every model-tier page was held
  (`test/fence-walkthrough.test.ts`). gpt-6 now has no row and keeps the
  requested cap, as before this wave, until a live check measures it.
- `repair conversation-labels` replays a still-pending batch with the CLI write
  wait, as #6185 made `repair extractor-facts` do.
- Wave 12's `repair timeline-comments` row cleanup is listed in the receipt
  coverage table with its TODO.
- Managed conversation outcome rows stay private under
  `facts.default_visibility=world` (the wave 10 #5120 contract), the managed
  publisher preflights at its first page with work, and
  `conversation_facts_backfill` reports a managed source another host owns as
  skipped (`sources_skipped_not_owner`), as `fence_repair` does.
- On a managed brain `takes rebuild` of a page whose takes are already in sync
  admits nothing and reports `takesUpserted: 0`.

## Receipts (lane R)

### Upgrade notes

- Managed conversation-fact extraction, fence reconcile, takes reextract and
  take-supersession reprojection now preflight like every other managed
  maintenance writer (`maintenancePreflight`): a source with a canonical
  checkout needs its active owner on this host before any model work. The
  cycle and takes paths preflight lazily, on the first page that needs a
  write, so a run with nothing to change never needs it.
- A request still pending after the job's wait is reported (`pages_pending`)
  and replayed on the next run with no model call.

### Decision 9: measured request volume

Run: 200 managed conversation pages on PGLite, three facts per segment with
1536-dimension vectors, injected extractor (no model calls), default caps
(25 pages, 10 fact pages, 8 MiB per request), receipts then force-compacted.
The measurement script was scratch (not committed). The 50k column scales the
200-page run linearly.

| 50k pages | Before batching (one request per page) | Batched, 25% outcome-only | Batched, 75% outcome-only |
|---|---|---|---|
| Requests (permanent request ids) | 50,000 (20% of `principalLifetimeIds`) | 3,750 (1.5%) | 2,000 (0.8%) |
| Reserved receipt bytes, 30-day window | 781 MiB (51% of `principalTerminalBytes`) | 61 MB (3.8%) | 33 MB (2.0%) |
| Retained receipt bytes after compaction | 87 MB (5.5%) | 17 MB (1.1%) | 14 MB (0.9%) |
| Intent per request | 128 KB fact page, 1.5 KB outcome-only | avg 1.6 MB, max 1.6 MB | avg 1.2 MB, max 1.4 MB |

The fact-page cap (10 per request) sets the request count: 150 fact pages
made 15 requests in the 25% run, 50 fact pages and 150 outcome-only pages
made 8 in the 75% run. A batch receipt keeps one result per member
(about 150 bytes each), so a compacted batch receipt keeps about 4.6 KB.
Both mixes are now well under Decision 9's 10% switch threshold. The
`maintenance_backpressure` stop at 80% of reserved receipt bytes and request
ids stays, and the up-front check counts the run's planned batches (pages
over 10).

Before batching, for the record: request ids and reserved receipt bytes were
charged per request (16,384 B flat), so each request type's share of the 20%
and 51% equalled its share of pages; a compacted per-page receipt kept about
1.75 KB.

### Functions touched in `src/commands/extract-conversation-facts.ts`

`ExtractConversationFactsResult` (two optional counters), `ExtractCoreState`
(`managed` is now the publisher or null), `processPage` (three managed call
sites; a managed page is enqueued and counted when its batch publishes),
`runExtractConversationFactsCore` (preflight line, run-stop errors in the two
page loops, the final batch flush before the checkpoint and on the error
path), `runExtractConversationFacts` (aggregate and print the
two counters), `terminalAuditFact`/`nonExtractableAuditFact` (version
stamp); new `currentConversationVersionToken`; removed `replacePageFacts`.
The managed logic lives in `src/core/facts/conversation-publication.ts`.

## Label repair (lane F)

### Decisions applied

- Decision 4 (A): apply expires an approved id set (captured-facts pattern);
  nothing is hard-deleted.
- Decision 5 (A): default set = rows whose context carries
  `segment 1970-01-01`; everything else on a label page is ambiguous, behind
  `--include-ambiguous` with its own hash. Confirmed no post-fix path writes
  that context: the fixed parser records an epoch-dated parse as not
  extractable (`conversationSkip`), so it never reaches segment extraction.

### Notes

- Approved pages apply in batches of up to 25 (one request and one receipt
  per batch on a managed brain, one transaction per batch otherwise), each
  page rechecked on its own under its lock; the apply reports one `retired`
  outcome per batch with per-page outcomes in its detail.

- Under a live `gbrain serve` on PGLite the lock refusal is already immediate
  (`acquireLock` throws `LiveServeLockError` without waiting), and the fatal
  CLI seam's fix is the stop → rerun → restart plan; the test pins it for this
  command. Owner delegation for repair kinds stays a TODO.

## Takes, concepts and jobs (lane T)

### Upgrade notes

- Supervisors started before the upgrade write `worker_exited` rows without a `pid`. `supervisor stop` pairs them with spawns by order and warns. After a restart on the new version, the rows carry the pid and the process start time.

### Integration points and follow-ups

- **Lane R (item 8).** `takes_rebuild` calls `extractTakes({ source: 'db', rebuild: true })`, which on a managed brain publishes through `reextractCoordinated` (`src/core/cycle/extract-takes.ts`). When Lane R moves `reextractCoordinated` onto its receipted takes intent, `takes rebuild` (local and delegated) is receipted with no further change. The op already takes `request_id` (`WRITE_REQUEST_PARAM`), and the CLI sends a fresh UUID. If the intent returns a `write_request` receipt, `runTakesRebuild` renders it as part of the JSON result; pending handling like `runTakesMutation` would be a small addition there.
- **Item 6 follow-up.** In-process, the watchdog aborts the per-job signal, so a cooperative job interrupted by the watchdog burns an attempt (`aborted: watchdog`). Isolated mode treats the watchdog as a shutdown. This was already the case and Decision 7 leaves it alone. `test/worker-shutdown-error-matrix.test.ts` pins the current behavior so any change is deliberate. The strict `ShutdownInterruptedError` stays a TODO.
- **Item 4.** No reader displays `promoted_row_num` today, so the "resolve to removed" reader in the plan has no consumer. The pointer is never cleared and never re-targeted. No doctor check flags a hand-deleted reservation, because #6221 owns fence_integrity.
- **Item 3.** `composeConceptRepublication` and `preserveCanonicalFences` (GBRA-55 #6161) are untouched. The recheck lives in `publishClassicConcept`, `conceptFile` and the new `fileHoldsPage`, plus `writePageThrough({ expectedFileBytes })`.

## Judge thinking caps (lane J)

Item 5 is confirmed on current master and fixed on this branch. Re-verification on 9cc7c4677:

- `chat()` raised a `thinking: 'off'` call's cap to 32,000 only for a thinking-by-default route without a switch (`gateway.ts:3461` on master), but the takes-quality projection priced `estimateCost(m, 5000, 2000)` (`takes-quality-eval/runner.ts:223`, `:259`) and the cross-modal preflight priced `maxTokens` (`cross-modal-eval/runner.ts:410`).
- `thinking-off.ts` had no Google or OpenAI row and `recipes/google.ts` declares no `thinking_by_default`, so `google:gemini-2.5-flash` on the default takes-quality panel ran with dynamic thinking inside the 2,000-token cap.
- The live probe below settles the open question: Gemini thoughts are billed inside `maxOutputTokens`. At a 128-token cap with no thinking config, gemini-2.5-flash spent 120 tokens thinking and returned `{"score": ` with `finishReason: length` (case G1b); gemini-3.8-flash did the same (G4b).

### The capability table (`src/core/ai/thinking-off.ts`)

`thinkingOffControl(modelStr)` returns the provider-options namespace and keys to set and whether they turn reasoning off (`disables`). `applyThinkingOff` and `thinkingOffMaxOutputTokens` (runtime, inside `chat()`) and gateway.ts `thinkingOffOutputCap` (the takes-quality and cross-modal estimates) all read it, so an estimate prices the cap the call sends.

| Route | Option sent under `thinking: 'off'` | Reasoning off? | Cap sent |
|---|---|---|---|
| `anthropic:*`, `deepseek:*`, `openrouter:deepseek/*` | `thinking: {type:'disabled'}` (unchanged) | yes | requested |
| `google:gemini-2.5-flash*`, `-2.5-flash-lite*` | `thinkingConfig: {thinkingBudget: 0}` | yes (probe G2: 0 reasoning tokens) | requested |
| `google:gemini-2.5-pro*` | `thinkingConfig: {thinkingBudget: 128}` (never `thinkingLevel`; probe G3: a 400 on 2.5) | no (128 is the documented minimum) | 32,000 |
| `google:gemini-3.7-flash`, `-3.8-flash`, `-3-pro*`, `-3.1-pro*` | `thinkingConfig: {thinkingLevel: 'low'}` | no (probe G5: 90 reasoning tokens) | 32,000 |
| `google:gemini-3-flash*`, `-3.5-flash`, `-3.6-flash`, `-3.1-flash-lite*`, `-3.5-flash-lite*` | `thinkingConfig: {thinkingLevel: 'minimal'}` | no (`minimal` does not guarantee off) | 32,000 |
| other `google:gemini-3+`, `gemini-*-latest` aliases | none (an unsupported level is a 400; probe G6) | no | 32,000 |
| `google:` image, TTS, audio, live, transcribe, computer-use ids; Gemini < 2.5 | none, no row | n/a | requested (or `isThinkingModel`) |
| `openai:gpt-5.1`, `-5.2`, `-5.4`(`-mini`/`-nano`), `-5.5`, `-5.6-{luna,sol,terra}` | `reasoningEffort: 'none'` | yes (probe O2) | requested |
| `openai:gpt-5`, `-5-mini`, `-5-nano` | `reasoningEffort: 'minimal'` | no | 32,000 |
| `openai:o1`, `o3`, `o3-mini`, `o4-mini` | `reasoningEffort: 'low'` | no | 32,000 |
| other OpenAI reasoning ids (`-pro`, `-codex`, unknown gpt-5/o-series) | none | no | 32,000 |
| `openai:gpt-6*` | none, no row | n/a | requested |
| `openai:*-chat*`, `gpt-4o*` | none, no row | n/a | requested |
| every other route | none, no row | when `isThinkingModel` (claude-cli Claude 5, GLM, local reasoning) | 32,000 if thinking, else requested |

Rules the table enforces:

- Never both Google fields: the Google option replaces any configured `thinkingConfig` wholesale (probe G7: both fields together are a 400 on 3.8 Flash).
- A namespace alone is not an off switch: only the native `google` and `openai` recipes get these rows. `openrouter:openai/gpt-5.2`, `openrouter:google/...` and `litellm:` routes get nothing.
- gpt-6 has no option because the pinned `@ai-sdk/openai` 3.0.58 lists only `o1`/`o3`/`o4-mini`/`gpt-5*` as reasoning models (`getOpenAILanguageModelCapabilities`) and drops `reasoningEffort` for gpt-6 with a warning. With no live measurement either, gpt-6 has no row and keeps the requested cap (see the integration note above); a TODO covers it.
- Sources: Google's generateContent thinking guide (levels per model, budget ranges), OpenAI's reasoning guide (supported efforts per model), and the probe.

Out of scope on purpose: the Google and OpenAI recipes still declare no `thinking_by_default`, so calls without `thinking: 'off'` keep today's default caps. Flipping them would raise default caps (and budget reservations) for every Gemini and gpt-5.5+ caller, which is a wider change than item 5.

### Tests

Fail on master source (src stashed, branch tests kept), pass on the branch:

- `test/ai/chat-thinking-off.test.ts` (real gateway against a local stub; the Google request is caught at `fetch`): 27 of 36 fail on master. These are the Google and OpenAI request-body rows (option and cap per model id), configured-value replacement (never both Google fields; OpenAI effort replaced, `prompt_cache_key` kept), the provider-options snapshot per model id, and estimate parity for every default takes-quality panel model and cross-modal slot plus a route that keeps reasoning (`openai:gpt-5`: sent cap = estimated cap = 32,000). The 9 that pass on master are the #5331 rows and three unchanged-behaviour guards (`gpt-4o-mini`, `gpt-5.2-chat-latest`, Google without thinking off). Branch: 36 pass.
- `test/eval-takes-quality-runner.serial.test.ts`: new case "a model that cannot turn thinking off is projected at the output cap its call sends". It fails on master (cycle runs under a $0.30 cap priced at 2,000 tokens) and passes on the branch (aborts before the call, priced at 32,000). Branch: 16 pass.
- Related suites, all green on the branch: `test/ai/` (910 pass), `cross-modal-default-slots`, `cross-modal-eval-prompt`, `default-model-panels`, `eval-cross-modal-batch`, `eval-takes-quality-boundaries`, `eval-takes-quality-pricing`, `nightly-quality-probe`, `cycle/synthesize-gateway-adapter`, `e2e/cross-modal-eval`.

### Live compatibility probe (Decision 6)

One run of `a scratch probe script (not committed), with the real AI SDK (`ai` 6.0.174, `@ai-sdk/google` 3.0.67, `@ai-sdk/openai` 3.0.58) and the provider options produced by the branch's `applyThinkingOff`. Caps were reduced from the judge's 2,000 so that the worst case stayed under the $0.02 bound. A plumbing dry run with invalid keys came first; it cost nothing (every call returned 400/401). Prices for the bound: gemini-2.5-flash $0.30/$2.50, gemini-3.8-flash $0.825/$4.125 (the non-global intro rate, an upper bound), gpt-5.2 $1.75/$14 (list price, above the repo's canonical $1.25/$10). gemini-3.8-flash is the newest Gemini 3.x Flash in `models.list` on 2026-10-07.

Summary:

| Case | Model | Options | Cap | Result | Reasoning / text tokens |
|---|---|---|---|---|---|
| G1 | gemini-2.5-flash | none (master) | 600 | stop | 193 / 21 |
| G1b | gemini-2.5-flash | none (master) | 128 | **length**, text `{"score": ` | 120 / 3 |
| G2 | gemini-2.5-flash | `thinkingBudget: 0` (branch) | 600 | stop | 0 / 30 |
| G3 | gemini-2.5-flash | `thinkingLevel: 'low'` | 64 | 400 "Thinking level is not supported for this model." | n/a |
| G4 | gemini-3.8-flash | none | 600 | stop | 130 / 20 |
| G4b | gemini-3.8-flash | none | 128 | **length**, text `{"score": 1` | 119 / 5 |
| G5 | gemini-3.8-flash | `thinkingLevel: 'low'` (branch) | 600 | stop | 90 / 20 |
| G6 | gemini-3.8-flash | `thinkingLevel: 'minimal'` | 64 | 400 "Thinking level MINIMAL is not supported for this model. Please retry with other thinking level." | n/a |
| G7 | gemini-3.8-flash | `thinkingLevel: 'low'` + `thinkingBudget: 0` | 64 | 400 "You can only set only one of thinking budget and thinking level." | n/a |
| O1 | gpt-5.2 | none (master) | 200 | stop; server echoes `reasoning.effort: "none"` | 0 / 31 |
| O2 | gpt-5.2 | `reasoningEffort: 'none'` (branch) | 200 | stop | 0 / 30 |

What it changed in the table: nothing had to move. It confirmed that `thinkingLevel` must never reach 2.5, that `minimal` is a 400 on 3.8 Flash, that both fields together are a 400, and that 3.8 Flash at `low` still reasons (so it gets headroom). It also showed gpt-5.2 already defaults to effort `none`, so the branch's explicit `none` changes no gpt-5.2 output; it pins the behaviour against a configured effort.

The exact requests and responses are in
[the probe record](capy-wave-9-followups-judge-probe.md).
