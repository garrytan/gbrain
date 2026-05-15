# Upstream patch: declare `max_batch_tokens` on the google recipe

**Status**: fork-local in `master`. Upstream PR pending (`upstream-fix/google-recipe-max-batch-tokens` branch). Drop this doc once upstream merges.

**Filed**: 2026-05-15
**Affected file**: `src/core/ai/recipes/google.ts`
**Scope**: +7 / -0, embedding touchpoint only, no logic change.

## Why

Since v0.32 (`types.ts` `no_batch_cap` opt-out) the gateway emits a once-per-process stderr warning whenever an embedding recipe omits `max_batch_tokens`:

```
[ai.gateway] recipe "google" declares an embedding touchpoint without max_batch_tokens; recursion is the only safety net for batch caps.
```

`google` is the only first-party recipe still missing the field (voyage, zhipu, dashscope, minimax, azure-openai all declare it). For fork operators routing through `google:gemini-embedding-001` (M3 cutover), the warning shows up in every `kos-compat-api /ingest` response output, every cron `gbrain` invocation, and every interactive query — it's load-bearing noise.

The recursive-halving fallback path works, but it's reactive — a CJK-dense batch that exceeds Gemini's effective per-request token cap will burn one failed request before halving. Pre-splitting avoids that round-trip entirely.

## Patch

Add three fields to `google.touchpoints.embedding`:

```ts
max_batch_tokens: 20_000,
chars_per_token: 2,
// safety_factor left at default 0.8
```

### Rationale on the constants

- **`max_batch_tokens: 20_000`** — Google's documented per-text cap is 2 048 tokens, with a soft per-request total around 20 k tokens before 429s hit on `gemini-embedding-001`. Conservative — leaves headroom for the safety factor.
- **`chars_per_token: 2`** — English averages ~4 chars/token (OpenAI default), CJK closer to ~1.5. Picking 2 reflects the realistic density on mixed-corpora brains (e.g. fork operator's brain is ~60 % Notion English / ~40 % CJK). Setting it to the OpenAI default 4 would let CJK-heavy batches over-stuff the request and hit 429 the recursion was meant to avoid.
- **`safety_factor`** — left implicit at gateway default 0.8. Pre-split lands at `20 000 × 0.8 / 2 = 8 000` chars/batch — well under any per-request floor Gemini publishes.

## Testing

- `bun run typecheck` — clean (~3 s)
- `bun test test/ai/recipes-contract.test.ts test/ai/gateway.test.ts` — 34 pass / 0 fail
- Manual probe via `kos-compat-api /ingest`: warning no longer surfaces in response `output`; embedding round-trips at 0.99+ similarity post-ingest

## Fork-local vs upstream

Same pattern as prior fork patches (PR #627 etc.). Fork carries the change locally so the operator stops seeing the warning today; once upstream merges the PR, the next sync auto-drops the diff (recipe field add is a clean text merge).
