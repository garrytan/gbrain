# Tracing (opt-in): Arize Phoenix, Langfuse, or any OTLP collector

gbrain can export one OpenTelemetry trace per MCP tool call, `think` run, search,
and LLM/embedding call. Spans use the
[OpenInference](https://github.com/Arize-ai/openinference) vocabulary, so Arize
Phoenix renders them with its LLM / RETRIEVER / RERANKER / TOOL / AGENT views and
Langfuse groups them into a trace. Off by default: when nothing below is set, no
provider is registered, no exporter is created, and every instrumented call site
pays one boolean check.

## Privacy: read this before you turn it on

Unlike `mcp_request_log` (which stores redacted parameter shapes), spans carry the
**full** query, prompt, retrieved chunk text, and tool parameters. That is the
point of a trace debugger. Only export to a collector you control. Values are
truncated to bound span size (16K chars per attribute, 25 documents × 1.5K chars
per retriever span), never redacted.

An API key alone never enables export. Consent stays explicit: you set the flag
or an endpoint.

## Turning it on

| Env | Effect |
|---|---|
| `GBRAIN_TRACING=1` | Enable export. Endpoint defaults to a local Phoenix at `http://localhost:6006`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `PHOENIX_COLLECTOR_ENDPOINT` | Collector base URL (no `/v1/traces` suffix). Setting either also enables export. |
| `PHOENIX_PROJECT_NAME` | Phoenix project the traces land in (default `gbrain`). |
| `PHOENIX_API_KEY` | Sent as `Authorization: Bearer <key>` for an auth-gated Phoenix. Without it an auth-gated collector answers every export with 401 and the exporter swallows it, so the startup banner prints `auth=bearer|none` to tell the two apart. Leave it unset to supply any other header spelling through the SDK's own `OTEL_EXPORTER_OTLP_HEADERS`. |
| `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` | Both together enable a second exporter to Langfuse (`Authorization: Basic base64(public:secret)`). One without the other is a silent no-op, never a half-export. |
| `LANGFUSE_BASE_URL` | Langfuse collector base URL (default `https://cloud.langfuse.com`; point at your self-hosted instance instead). |

Phoenix and Langfuse are independent: either, both, or neither can be active.

Local Phoenix in one line:

```bash
docker run -d --name phoenix -p 127.0.0.1:6006:6006 arizephoenix/phoenix:latest
GBRAIN_TRACING=1 gbrain search "what did we decide about pricing"
```

Then open `http://localhost:6006`.

## What you get

Spans nest by call structure. The root is the MCP tool call (or the CLI command's
top-level operation); the leaves are provider calls.

| Span | Kind | Notes |
|---|---|---|
| `mcp.<tool>` | TOOL | One per tool call, both stdio and HTTP transports. Carries `tool.name`, `gbrain.remote`, `gbrain.source_id`; `tool.is_error` + `tool.error` when the handler returned an error result. |
| `think` | AGENT | The whole GATHER → SYNTHESIZE pipeline. Model used, pages/takes gathered, citations, gaps. |
| `think.gather` | CHAIN | Retrieval streams feeding `think`. |
| `hybrid_search` | RETRIEVER | Final ranked documents (content + score) plus the pipeline decisions the search reported: mode, intent, expansion, autocut, adaptive return, token budget. |
| `search.post_fusion` | CHAIN | Top-of-ranking snapshot before and after salience / recency / backlink / graph boosts, so a boost-induced reorder is visible. |
| `search.rerank` | RERANKER | Whether the reranker fired or failed open to fusion order, scored count, per-document rank deltas. |
| `gateway.chat` | LLM | One span per chat call (each tool-loop round gets its own). Input/output messages render as a transcript; token counts, provider, stop reason. |
| `gateway.expand` | LLM | Query expansion. Token counts are stamped only when the provider reported them (`llm.token_count.*` absent otherwise, never a measured zero). |
| `gateway.embed` | EMBEDDING | Text count, total chars, dimensions. `embedding.token_count_source` is `provider` or `estimated`, so an estimate never masquerades as a measurement. Single-text (query) embeds attach the text; batch document embeds do not. |
| `gateway.rerank` | RERANKER | The provider rerank call: model, document counts, top score. |
| `subagent.turn` | LLM | The minion subagent loop talks to the Anthropic SDK directly, so it gets its own span with token counts incl. cache read/write, `gbrain.job_id`, `gbrain.turn_index`. |

## Caller attribution: which phase spent the tokens

Every gateway span also carries **who** was calling:

- `gbrain.caller` — a low-cardinality phase label, e.g. `dream.synthesize`,
  `dream.extract_atoms`, `subagent`. The dream cycle stamps `dream.<phase>` on
  every phase automatically (`timePhase` in `src/core/cycle.ts`); any other
  orchestrator can wrap a region with `withCallLabel(label, fn)` from
  `src/core/call-label.ts`. When no region is active, the active
  `BudgetTracker`'s label is used instead, so paths that already carry a budget
  label (brainstorm, skillopt, embed backfill) need no second wrap.
- `gbrain.budget_label` — the finer-grained budget label when it differs from
  the caller (e.g. caller `dream.extract_atoms`, budget `extract-atoms:wiki`).
  Emitted only when it adds information.

The attribute is absent when neither is present. An unlabeled span is honest; a
span labeled `unknown` pollutes group-by.

This is the exporter for the spend attribution gbrain already does internally:
`BudgetTracker.label` is what gets stamped, so a Phoenix or Langfuse dashboard can
answer "how many tokens did the synthesize phase burn this week" instead of only
"how many tokens did this model burn".

## Adding a span

```ts
import { withSpan } from '../tracing.ts';

return withSpan('my.operation', { kind: 'CHAIN', input: query, attributes: { 'my.knob': 3 } }, async (span) => {
  const out = await impl();
  span.setAttributes({ 'my.count': out.length });
  span.setOutput(out);
  return out;
});
```

`withSpan` returns the callback's result unchanged. When tracing is off the
handle is a shared no-op object. A thrown error is recorded on the span
(`exception` event + ERROR status) and rethrown. Pattern used throughout: keep
the original function body as `fooImpl` and make `foo` the thin wrapper, so the
implementation never reaches for the span.

Tests that need to assert span content install a tracer directly with
`__setTracerForTests(tracer)` (see `test/gateway-span-attribution.serial.test.ts`)
because `withSpan` hands out the no-op handle whenever tracing is off.
