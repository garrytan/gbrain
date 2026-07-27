# Content Guardrail Seams

GBrain exposes **vendor-neutral guardrail seams** at the boundaries where
external content enters the retrieval layer and where queries/tool-inputs enter
the LLM gateway. A guardrail is any external classifier — a content firewall, a
prompt-injection detector, a PII scrubber — that wants to *observe* content at
those boundaries.

The OSS distribution ships **inert**: zero guardrails are registered by default,
and every seam is a no-op until an operator registers a provider.

## Design contract (hard invariants)

These hold for every seam and are enforced by `test/guardrails.test.ts`:

- **Observe-only.** `runGuardrails()` returns `void`. Callers never branch on a
  provider verdict. A guardrail registered through this interface *cannot*
  block, rewrite, drop, retry, or reorder GBrain behavior. Enforcement, if ever
  added, will get its own explicitly-named seam and its own RFC — it will not
  silently reuse this one.
- **Fail open.** Missing config, provider throw/reject, timeout, and network
  error are all swallowed. A broken guardrail never breaks an ingest, a query,
  or a tool call.
- **Inline await.** Hooks await the provider before proceeding, so the
  classifier sees content at the exact pre-persist / pre-inference moment.
- **No verdict persistence.** GBrain writes no guardrail rows. Providers own
  their own audit trail.
- **Content boundaries.** Hooks pass only the ingest/user-facing payload — the
  markdown/code body, the last user message, the expansion query, the tool
  input. They never pass system prompts, full chat history, tool *output*, LLM
  output, embeddings, or multimodal/OCR/rerank payloads.

## The five seams

All seams call `runGuardrails({ hook, content, metadata })` from
`src/core/guardrails.ts`.

| `hook` | Location | Fires |
| --- | --- | --- |
| `file_storage.markdown` | `import-file.ts` → `importFromContent` | After `parseMarkdown` + size guard, **before** content-sanity, hashing, chunking, embedding, DB write |
| `file_storage.code` | `import-file.ts` → `importCodeFile` | After code size guard, **before** hashing, code-chunking, embedding, DB write |
| `ai_gateway.chat` | `ai/gateway.ts` → `chat` | On the **latest user message only**, before provider inference |
| `ai_gateway.expand` | `ai/gateway.ts` → `expand` | On the query, before the expansion model call |
| `ai_gateway.tool_input` | `ai/gateway.ts` → `toolLoop` | On `{toolName, input}`, before pending-persist and before tool execution |

The two `file_storage.*` hooks cover every natural ingest caller that routes
through `importFromContent` / `importCodeFile`: `gbrain import`, sync, capture,
`put_page`, subagent `brain_put_page`, trusted-workspace writes,
`ingest_capture`, inbox daemon dispatch, reindex, code reindex, and the public
import APIs.

## Writing a guardrail provider

```ts
import { registerGuardrailProvider, type GuardrailInput } from 'gbrain/core/guardrails';

registerGuardrailProvider({
  id: 'my-firewall',
  async classify(input: GuardrailInput) {
    // input.hook      — which boundary ('file_storage.markdown', etc.)
    // input.content   — the raw text to classify
    // input.metadata  — provider-opaque context (slug, source_kind, tool_name, model, ...)
    //
    // Do your own timeout/retry/logging here. The return value is IGNORED by
    // GBrain — return a typed verdict only if your own audit code consumes it.
    await fetch(MY_API, { method: 'POST', body: JSON.stringify({ text: input.content }) });
  },
});
```

Register once at process init (e.g. from a plugin entry or an operator boot
hook). Registration is idempotent by `id`, so a re-init won't double-fire.

### Provider responsibilities

GBrain deliberately keeps the seam minimal. The provider owns:

- **Timeout discipline.** GBrain does not impose a timeout in `runGuardrails`
  so you can tune per-deployment latency. Use an `AbortController`.
- **Secret handling.** Read API keys from env at call time. Never log the key.
- **Redacted logging.** Don't log raw classified content (it may itself be the
  payload you're trying to protect). Log a hash + verdict, not the body.
- **Async fan-out.** If you don't want to block ingest on your classifier,
  enqueue inside `classify` and return immediately. The seam awaits *your*
  function; what it does is up to you.

## Example: shadow-mode firewall provider

A typical "shadow mode" provider (classify, log a redacted verdict, change
nothing) is ~80 lines and lives entirely in the provider's own package. See
the reference provider doc shipped to integration partners for a complete
`classify` implementation that:

1. resolves `<base>/classify` from an env URL,
2. posts `{ text, hook, metadata }` with an `x-api-key` header,
3. parses a `{ prediction, blocked, score, threshold }` response,
4. emits one redacted stderr line (`status=… prediction=… content_sha256=…`),
5. fails open on every error path.

Because the verdict is ignored by GBrain, "shadow mode" requires *no* special
GBrain flag — it is the only mode this interface supports. Enforcement would be
a separate, future, RFC-gated seam.
