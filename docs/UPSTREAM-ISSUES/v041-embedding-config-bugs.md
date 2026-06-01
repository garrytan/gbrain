# Upstream issues: embedding config/resolution bugs (found during §6.32 convergence, gbrain v0.41.14.0)

**Status**: **FILED** 2026-05-31 — Bug 1 → [garrytan/gbrain#1716](https://github.com/garrytan/gbrain/issues/1716), Bug 2 → [garrytan/gbrain#1717](https://github.com/garrytan/gbrain/issues/1717). Found while converging the fork's brain onto
`openai:text-embedding-3-large` @1536 via an OpenAI-compatible relay. Both are real upstream
bugs; the fork worked around both. Repro on gbrain 0.41.14.0, Postgres engine, macOS, Bun 1.3.

---

## Bug 1 (P1): `litellm` recipe is unusable for embedding — `diagnoseEmbedding` rejects it unconditionally

**File**: `src/core/ai/gateway.ts:668-682` (`diagnoseEmbedding`).

```ts
const isUserProvided = (tp as any).user_provided_models === true;
if (
  Array.isArray(tp.models) &&
  tp.models.length === 0 &&
  (recipe.id === 'litellm' || isUserProvided)
) {
  return { ok: false, reason: 'user_provided_model_unset', model: modelStr, provider: parsed.providerId, recipeId: recipe.id };
}
```

The `litellm` recipe ships `touchpoints.embedding.models: []` + `user_provided_models: true`.
This check fires **whenever the recipe is litellm**, regardless of whether the user actually
configured a concrete model. So with `embedding_model = litellm:text-embedding-3-large`
properly set (and registered via `registerExtendedModel` at gateway configure-time, lines
~383/442), `validateEmbeddingCreds()` (`src/core/embed-preflight.ts:48`) still throws
`user_provided_model_unset` → `gbrain embed` refuses with:

```
Provider "litellm" requires a specific model name to be configured.
  Set one: gbrain config set embedding_model litellm:<model-name>
```

…which is exactly what the user already did. The check should consult the resolved/registered
model (or the configured `embedding_model`'s model part) and only fail when it's genuinely
absent — not fail unconditionally for the litellm recipe. As-is, litellm is unusable for
embedding even when correctly configured.

**Fork workaround**: use the native `openai` recipe + `OPENAI_BASE_URL` to point at the
OpenAI-compatible relay (the `openai` recipe has a non-empty models list, so the check is
skipped). Works, but means the documented litellm path is dead for embeddings.

---

## Bug 2 (P2): embed path mislabels the `content_chunks.model` column as the gateway default

**Files**: `src/commands/embed.ts` (`embedPage` ~336-342, `embedAll`/`embedOnePage` ~435-441,
import path) build the `ChunkInput[]` for `upsertChunks` **without a `model` field**:

```ts
const updated: ChunkInput[] = chunks.map(c => ({
  chunk_index: c.chunk_index,
  chunk_text: c.chunk_text,
  chunk_source: c.chunk_source,
  embedding: embeddingMap.get(c.chunk_index) ?? undefined,
  token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
  // model: <-- omitted
}));
```

`upsertChunks` (`src/core/postgres-engine.ts:1868`) then writes
`chunk.model || DEFAULT_EMBEDDING_MODEL` → every embedded chunk is tagged
`zeroentropyai:zembed-1` (the v0.36 default) **regardless of the model that actually produced
the vector**. The vectors are correct (`embedBatch` uses `getEmbeddingModel()`); only the
`model` column label is wrong. This is very misleading for diagnostics, `gbrain doctor`,
mixed-model detection, and anyone reading the column to learn what space a chunk is in.

**Fix**: thread the resolved embedding model (`getEmbeddingModel()`) into the `model` field of
the upserted chunks.

**Fork workaround**: after each re-embed, `UPDATE content_chunks SET
model='openai:text-embedding-3-large' WHERE …` to correct the cosmetic label.

---

## Related friction (not necessarily bugs, but surprising)

- `gbrain config set embedding_model X` rejects the write as a **no-op** when X equals the
  *file-inclusive resolved* value — so you cannot set the DB-plane `config` value to match an
  existing file-plane `config.json` value. Combined with the embed pipeline reading a specific
  plane, this made it impossible to fix via `config set`; we direct-`UPSERT`ed the DB `config`
  table. A `--force` that actually writes (it's documented but still rejected the no-op here)
  or clearer plane semantics would help.
- `config get` (DB plane) vs `config show` (resolved) vs `providers` reported **three different
  `embedding_model` values** simultaneously on the same brain, and `config show`/`providers`
  surfaced a value with no traceable source in file/DB/env. Hard to debug "what model will
  actually be used."
- `put`/`get`/`query` route to the daemon (its boot env decides the model) while `embed`/
  `config` run CLI-in-process (read file/env/DB). Undocumented split that made smoke-testing
  embedding config very confusing (every `put`-based test measured the daemon's model, not the
  CLI config under test).
