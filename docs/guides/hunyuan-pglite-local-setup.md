# Local GBrain Setup: PGLite + Hunyuan Embeddings

## Goal

Run GBrain locally against `PGLite` while using a Hunyuan OpenAI-compatible
embedding endpoint for semantic search. This guide documents the exact local
setup that was debugged and verified on this machine, including the two failure
modes that caused search to break:

1. custom-endpoint embeddings coming back incorrectly through the SDK path
2. vector dimension drift between the embedding provider and the local schema

If you want the shortest stable outcome, the validated baseline is:

- engine: `pglite`
- embedding model: `hunyuan-embedding`
- embedding dimensions: `1024`
- local brain path: `~/.gbrain/brain.pglite`
- wiki source: `~/wiki`

---

## Validated Local Baseline

### Repos and paths

- GBrain repo: `~/gbrain`
- Wiki repo / markdown source: `~/wiki`
- GBrain config: `~/.gbrain/config.json`
- Local DB: `~/.gbrain/brain.pglite`

### Credential source

This local setup reads Hunyuan credentials from shell environment exported in
`~/.zshrc`:

```bash
export HUNYUAN_API_KEY=...
export HUNYUAN_BASE_URL=...
```

Those values are then copied into `~/.gbrain/config.json` as the active
embedding endpoint for GBrain.

### Required config

`~/.gbrain/config.json` should contain at least:

```json
{
  "engine": "pglite",
  "database_path": "/Users/wuyun/.gbrain/brain.pglite",
  "openai_api_key": "<same value as HUNYUAN_API_KEY>",
  "openai_base_url": "<same value as HUNYUAN_BASE_URL>",
  "embedding_model": "hunyuan-embedding",
  "embedding_dimensions": 1024
}
```

---

## Important Implementation Notes

### 1. Use `hunyuan-embedding`, not `text-embedding-3-large`

The Hunyuan endpoint used here accepts an OpenAI-compatible `/embeddings`
request shape, but it does **not** accept OpenAI embedding model names. If the
model is left as `text-embedding-3-large`, embedding generation fails.

Use:

```json
"embedding_model": "hunyuan-embedding"
```

### 2. The local vector dimension must be `1024`

This setup was initially misconfigured with a smaller vector size. That caused:

- failed inserts
- `NaN` query scores
- vector search returning empty or useless results

The working local schema must match the provider's actual output dimension:

```text
1024
```

These schema files must stay aligned with the provider dimension:

- `src/core/pglite-schema.ts`
- `src/core/schema-embedded.ts`

### 3. Custom embedding endpoints may need a raw HTTP path

For this local Hunyuan setup, the generic OpenAI SDK path produced broken
embeddings during debugging. The working fix was to let `src/core/embedding.ts`
use a raw HTTP `/embeddings` request for non-OpenAI base URLs.

This matters because a broken embedding response can look superficially valid
while still destroying retrieval quality.

### 4. Chinese search needed an explicit CJK-compatible fallback

Default keyword search in GBrain is English full-text search. That is fine for
queries like:

```bash
gbrain query 'Hermes memory system'
```

but poor for queries like:

```bash
gbrain query 'Hermes 记忆 系统'
gbrain query '智能 收藏 回顾 系统'
```

The local PGLite search path was patched with a CJK-aware fallback in
`src/core/pglite-engine.ts`, so Chinese and mixed Chinese/English queries can
still recall relevant pages when English FTS alone would fail.

---

## Fresh Setup / Recovery Flow

Use this when:

- embeddings are missing
- vector search is broken
- scores are `NaN`
- dimensions changed
- the local DB needs to be rebuilt cleanly

### Step 1. Confirm code and config baseline

From `~/gbrain`, verify:

- schema vector dimension is `1024`
- config uses `hunyuan-embedding`
- config uses `embedding_dimensions = 1024`

### Step 2. Backup the existing local brain

Before destroying the local DB, make a directory backup:

```bash
cp -R ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.backup
```

If the DB is known-bad because of a dimension mismatch, keep the backup for
forensics but do not reuse it as-is.

### Step 3. Rebuild the local DB

```bash
rm -rf ~/.gbrain/brain.pglite
cd ~/gbrain
gbrain init
```

Note: `gbrain init` may rewrite `~/.gbrain/config.json`, so restore the Hunyuan
settings afterward if needed.

### Step 4. Re-apply the local embedding config

Ensure `~/.gbrain/config.json` again contains:

- `openai_api_key`
- `openai_base_url`
- `embedding_model = hunyuan-embedding`
- `embedding_dimensions = 1024`

### Step 5. Import wiki content without inline embedding

```bash
cd ~/gbrain
gbrain import ~/wiki --no-embed
```

### Step 6. Rebuild graph extras

```bash
gbrain extract links --source db
gbrain extract timeline --source db
```

### Step 7. Generate embeddings

```bash
gbrain embed --stale
```

---

## Verification Checklist

## Current Re-validation Notes (2026-05)

This setup was re-run on the current local machine after the original guide was
written. The observed healthy baseline was:

- `gbrain 0.16.4`
- `gbrain stats` showed `Pages: 12`, `Chunks: 14`, `Embedded: 14`
- `gbrain query 'Hermes memory system'` returned the expected concept page
- `gbrain query 'Hermes 记忆 系统'` and `gbrain query '智能 收藏 回顾 系统'`
  both returned relevant results
- `gbrain search '智能 收藏 回顾 系统'` also worked, confirming the local
  CJK fallback path was active
- `gbrain extract links --source db --dry-run` and
  `gbrain extract timeline --source db --dry-run` both ran successfully

Two details are important enough to call out explicitly:

1. A successful embedding API response is **not** sufficient proof that the
   vectors are healthy.
2. `gbrain doctor --json` top-level `schema_version` is the doctor output schema
   version, not the database migration version.

### Health

```bash
cd ~/gbrain
gbrain stats
gbrain doctor --json
```

Expected:

- `Embedded` equals total chunk count
- doctor shows embeddings coverage as healthy / complete

### English retrieval

```bash
gbrain query 'Hermes memory system'
```

Expected: results include `concepts/hermes-memory-system` near the top.

### Chinese retrieval

```bash
gbrain query 'Hermes 记忆 系统'
gbrain query '智能 收藏 回顾 系统'
```

Expected: relevant concept/entity pages are returned, not `No results.`

### Keyword-only Chinese fallback

```bash
gbrain search '智能 收藏 回顾 系统'
```

Expected: Chinese pages still match through the CJK-aware local fallback.

---

## Symptoms and What They Mean

### Symptom: `gbrain embed --stale` fails with a model error

Likely cause:
- wrong embedding model name

Fix:
- set `embedding_model` to `hunyuan-embedding`

### Symptom: query scores show `NaN`

Likely cause:
- schema dimension and embedding dimension do not match

Fix:
- update schema to `1024`
- rebuild `~/.gbrain/brain.pglite`
- re-import and re-embed

### Symptom: vector search returns 0 rows even though embeddings exist

Likely cause:
- broken embeddings were written
- or the custom endpoint path is not producing valid numeric vectors
- or an SDK call returned a superficially successful response whose embedding was
  all zeros

Fix:
- verify embedding output directly
- check both vector length and non-zero count, not just request success
- ensure custom endpoint goes through the validated raw HTTP path
- rebuild embeddings after the code fix

### Symptom: `gbrain doctor --json` seems to report the wrong schema version

Likely cause:
- the top-level `schema_version` field is being misread as the database migration
  version

Fix:
- treat top-level `schema_version` as the doctor JSON output format version
- inspect the individual `checks` entries for actual database version / migration
  findings

### Symptom: Chinese query returns `No results.` but English works

Likely cause:
- query is falling back to English FTS only

Fix:
- ensure the local CJK-aware `searchKeyword()` path in
  `src/core/pglite-engine.ts` is present

---

## Known Non-Blocking Noise

During import, this local setup may print:

```text
fatal: ambiguous argument 'HEAD'
```

This is usually because the wiki repo does not yet have a valid git `HEAD`
commit. It does **not** block:

- import
- embedding generation
- search
- local retrieval verification

Treat it as a repo hygiene issue, not a retrieval blocker.

---

## Operational Recommendation

This setup is now valid for local use, but if the brain grows materially larger
or reliability becomes more important than zero-setup local operation, prefer a
real Postgres + pgvector backend. PGLite is excellent for local iteration, but a
server-backed Postgres deployment remains the stronger default for long-term,
higher-scale retrieval.

For this machine, though, the local configuration above is the verified working
baseline.