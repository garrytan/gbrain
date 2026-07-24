# Conversation parser LLM fallback

The conversation parser has two stages:

1. A deterministic registry recognizes known transcript formats.
2. An optional LLM fallback parses pages that every built-in pattern rejects.

The second stage is disabled by default. Enabling it is a privacy decision
because unmatched transcript text can be sent to the configured utility-tier
model provider.

## Enable or disable the fallback

Enable it for the current brain:

```bash
gbrain config set conversation_parser.llm_fallback_enabled true
```

Disable it:

```bash
gbrain config set conversation_parser.llm_fallback_enabled false
```

The key is registered explicitly, so neither command needs `--force`.
Values other than the exact string `true` leave the fallback disabled.

The setting affects conversation fact extraction. It does not make the
synchronous `conversation-parser scan` command call a model, and it does not
enable the separate LLM polish scaffold.

## Select the utility model and run a canary

Inspect the model routing before enabling a production run:

```bash
gbrain models
```

The fallback uses the resolved `utility` tier. Override that tier when the
brain should use a different configured provider or model:

```bash
gbrain config set models.tier.utility <provider:model>
```

Start with one known unmatched page and an explicit cost cap:

```bash
gbrain extract-conversation-facts \
  --source-id <source-id> \
  --slug <conversation-slug> \
  --max-cost-usd 1
```

Do not add `--dry-run` to this canary. Dry runs deliberately stop before the
fallback boundary, so they cannot prove provider routing or model output.
Success emits the per-page fallback log described under
[Operator visibility](#operator-visibility). After the canary, remove `--slug`
to process the source normally.

## When the fallback runs

For each eligible conversation page, extraction:

1. Reads the same body used by the deterministic parser, including a configured
   raw transcript sidecar for meeting pages.
2. Calls `parseConversation(body, { page })`.
3. Uses the deterministic messages when any built-in pattern succeeds.
4. Calls the LLM fallback only when the parse phase is exactly `no_match`, the
   message list is empty, the opt-in key is `true`, and this is not a dry run.
5. Splits accepted fallback messages into the normal extraction segments.

The fallback never replaces, edits, or polishes a successful deterministic
parse. Adding a built-in pattern therefore removes model use for that format
without changing configuration.

Dry runs remain local and cost-free. They report deterministic segmentation
only and never send unmatched content to a provider.

## Data sent to the model

The full unmatched body is processed in overlapping windows of at most 100
non-empty lines, with up to 20 lines of preceding context. Blank lines are
omitted. Every model request receives:

- an instruction to treat the transcript as untrusted data;
- an authoritative page date when one can be derived;
- the sampled transcript inside an explicit chat-log envelope.

The system prompt tells the model not to follow commands or instructions found
inside transcript content. It asks for message extraction only.

Each window is cached independently. Overlap results with the same normalized
speaker and timestamp are deduplicated; when one body contains the other, the
longer body wins. This preserves common multi-line messages that straddle a
window boundary. If any later window has an ordinary provider or parse failure,
the fallback returns no page result and extraction does not advance the
checkpoint. Successful earlier windows stay cached for the retry.

Fallback calls allow up to 8,000 output tokens. Any non-terminal model stop,
including length truncation, refusal, content filtering, tool use, or an
unrecognized provider stop, is rejected before parsing and caching. A
syntactically valid partial JSON array therefore cannot advance a checkpoint.

The utility model is resolved once per source run through the normal model
configuration chain. The default fallback is the utility-tier Anthropic model.

## Date and timestamp behavior

The fallback uses the deterministic parser's date precedence:

1. an explicit caller date;
2. `frontmatter.date`;
3. the page effective date;
4. `1970-01-01` when no date is known.

A real page date is included in both the prompt and the content-hash cache key.
Two pages with identical time-only transcript text but different dates cannot
share a cached parse.

Returned timestamps must be strict RFC3339 date-times with seconds and an
explicit `Z` or numeric timezone offset. Calendar fields are validated before
parsing. Accepted timestamps are normalized to whole-second UTC form:

```text
YYYY-MM-DDTHH:MM:SSZ
```

Date-only values, timezone-less values, impossible calendar dates, timestamps
more than 24 hours in the future, blank speakers, and blank message bodies are
discarded. Valid messages are stable-sorted by timestamp before segmentation.
Canonical chronological UTC output keeps segment filtering and durable
checkpoint comparisons stable and prevents future checkpoint poisoning.

If no page date is known, the prompt retains the historical epoch fallback.
Full timestamps present in the transcript can still be extracted normally.

## Non-chat and failure behavior

The model is instructed to return an empty JSON array for non-chat content.
An empty response, malformed JSON, unavailable provider, or transport failure
leaves the page with no messages. Extraction skips that page and continues.

The fallback is fail-open with respect to parser availability. It does not turn
a model outage into a deterministic-parser outage.

Cancellation and `BudgetExhausted` are control-flow signals, not provider
failures. The extraction caller explicitly propagates them through the
fail-open boundary so aborts stay prompt and hard cost caps remain effective.
An `AbortError` from a provider timeout still fails open while the caller's own
abort signal remains live.

The gateway can discover an underestimated budget overage only after the final
provider result. Extraction checks tracker spend against its cap after the run,
so an overage remains visible even when there is no next model reservation.

## Cache and repeat runs

Successful fallback results use the shared conversation-parser cache:

- an in-process map for repeat calls during one process;
- the `conversation_parser_llm_cache` table for repeat calls across processes.

Each chunk's cache key includes the call shape, resolved model, page date
metadata, and chunk content hash. A cached response is still validated before
it originally enters the cache.

Once fallback messages produce extractable segments, the ordinary per-page
checkpoint advances to the newest segment timestamp. A later run can read the
cached parse, apply the checkpoint watermark, and skip already completed
segments without another provider call.

## Operator visibility

`ExtractConversationFactsResult.pages_llm_fallback` counts pages for which the
fallback returned at least one valid message. The command also logs:

```text
[extract-conversation-facts] LLM fallback parsed N message(s) for <slug>
```

The multi-source CLI summary reports the total number of fallback-parsed pages.
A zero count means either the fallback was disabled, deterministic patterns
handled every page, or fallback attempts returned no valid messages.

## Maintainer contracts

Keep these boundaries intact when changing the fallback:

- Default off. Page text must not reach the fallback without the exact opt-in.
- Never call the provider during `--dry-run`.
- Deterministic first. Invoke it only for phase `no_match`.
- One model resolution per source run, not per page.
- Use `deriveDateContext({ page })` so regex and LLM timestamps share metadata.
- Put date metadata in the hashed request content to prevent cross-date cache
  collisions.
- Process every non-empty line in bounded cached overlapping windows. Preserve
  common cross-boundary continuations through overlap and deterministic
  deduplication. Never checkpoint a partial page after a later window fails or
  returns a non-terminal stop reason.
- Validate and canonicalize all model-produced fields before segmentation.
- Stable-sort accepted messages before segmenting or checkpointing them.
- Keep the exact config key in `KNOWN_CONFIG_KEYS`. Do not register the whole
  `conversation_parser.*` namespace while other scaffolded keys remain unwired.
- Preserve `[]` and `null` as skip-page outcomes.
- Propagate cancellation and budget-stop errors selected by the extraction
  caller; fail open only for ordinary provider and parse failures.
- Never persist inferred regexes or promote model guesses into the built-in
  registry.

## Test coverage

The focused tests cover:

- default-off behavior with zero fallback calls;
- enabled dry-run behavior with zero provider calls;
- exact config-key registration;
- a successful production-path fallback;
- page-date prompt and cache-key separation;
- durable checkpoint advancement and cache reuse;
- complete processing beyond the first 100 non-empty lines;
- cross-boundary continuation preservation and overlap deduplication;
- rejection of truncated, refused, and content-filtered model results;
- all-or-nothing page results when a later chunk fails;
- non-chat empty arrays and malformed output;
- strict timestamp normalization, ordering, and invalid-item filtering;
- provider-unavailable and transport-failure behavior;
- provider-timeout versus caller-cancellation behavior;
- thrown and post-record budget-stop reporting.

Run the focused surface with:

```bash
bun test test/conversation-parser/llm-base.test.ts \
  test/conversation-parser/llm-fallback.test.ts \
  test/extract-conversation-facts.test.ts \
  test/config-set.test.ts
```
