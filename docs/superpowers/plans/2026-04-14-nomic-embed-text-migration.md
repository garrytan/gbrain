# Nomic Embed Text Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate GBrain's default embedding stack to `nomic-embed-text`, add role-aware query/document shaping, and support the change across SQLite and Postgres paths.

**Architecture:** Keep the existing local HTTP provider contract, but add a thin embedding preparation layer that shapes inputs by intent. Apply the new model as the default local embedding model and add a Postgres migration to shrink pgvector storage from 1536 to 768 dimensions. Preserve compatibility for non-nomic models by only applying prefixes when the active model is `nomic-embed-text`.

**Tech Stack:** Bun, TypeScript, Ollama-compatible `/api/embed`, SQLite, Postgres + pgvector, Bun test

---

### Task 1: Lock in embedding behavior with failing tests

**Files:**
- Modify: `test/local-offline.test.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write failing tests for the new default model and input shaping**

Add tests that assert:

```ts
expect(createLocalConfigDefaults().embedding_model).toBe('nomic-embed-text');
```

and that a fake provider receives:

```ts
'search_document: document body'
'search_query: who is alice?'
```

for nomic, while a non-nomic model still receives raw text.

- [ ] **Step 2: Run focused tests to verify they fail for the expected reason**

Run:

```bash
bun test test/local-offline.test.ts test/config.test.ts
```

Expected:

- default-model assertions fail because current code still returns `bge-m3`
- input-shaping assertions fail because current code still sends raw text

- [ ] **Step 3: Commit checkpoint**

```bash
git add test/local-offline.test.ts test/config.test.ts
git commit -m "test: define nomic embedding migration behavior"
```

### Task 2: Implement model-aware embedding preparation

**Files:**
- Modify: `src/core/embedding/provider.ts`
- Modify: `src/core/embedding.ts`
- Modify: `src/core/search/hybrid.ts`
- Modify: `src/core/config.ts`

- [ ] **Step 1: Implement minimal provider metadata and defaults**

Change the local default model constant to:

```ts
const DEFAULT_LOCAL_MODEL = 'nomic-embed-text';
```

and expose a small capability field or helper that identifies when nomic task prefixes are required.

- [ ] **Step 2: Add explicit query/document preparation helpers**

Implement small helpers in `src/core/embedding.ts` along these lines:

```ts
function prepareEmbeddingInput(text: string, kind: 'document' | 'query', provider: ResolvedEmbeddingProvider): string {
  if (provider.capability.model === 'nomic-embed-text') {
    return kind === 'document'
      ? `search_document: ${text}`
      : `search_query: ${text}`;
  }
  return text;
}
```

Then route:

- `embedChunks(...)` through `document`
- hybrid search query embedding through `query`

- [ ] **Step 3: Run the focused tests and verify they pass**

Run:

```bash
bun test test/local-offline.test.ts test/config.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit checkpoint**

```bash
git add src/core/embedding/provider.ts src/core/embedding.ts src/core/search/hybrid.ts src/core/config.ts test/local-offline.test.ts test/config.test.ts
git commit -m "feat: support nomic query and document embeddings"
```

### Task 3: Add Postgres migration for 768-dim pgvector storage

**Files:**
- Modify: `src/core/migrate.ts`
- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Modify: `test/migrate.test.ts`

- [ ] **Step 1: Write failing migration expectations**

Add unit-level expectations that:

```ts
expect(LATEST_VERSION).toBeGreaterThan(4);
```

and verify the source contains the new migration name and references to `vector(768)` or updated embedding dimensions where appropriate.

- [ ] **Step 2: Run migration-focused tests to verify failure**

Run:

```bash
bun test test/migrate.test.ts
```

Expected: FAIL because the migration has not been added yet.

- [ ] **Step 3: Implement the migration and baseline schema updates**

Add a new migration that:

- drops the existing embedding index if present
- alters `content_chunks.embedding` to `vector(768)`
- updates `config.embedding_dimensions` to `768`
- recreates the vector index

Also update the baseline schema in `src/schema.sql`, then regenerate:

```bash
bun run build:schema
```

- [ ] **Step 4: Run migration-focused tests and schema-related regressions**

Run:

```bash
bun test test/migrate.test.ts test/doctor.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit checkpoint**

```bash
git add src/core/migrate.ts src/schema.sql src/core/schema-embedded.ts test/migrate.test.ts
git commit -m "feat: migrate pgvector storage to 768 dimensions"
```

### Task 4: Update init, docs, and verification guidance

**Files:**
- Modify: `src/commands/init.ts`
- Modify: `README.md`
- Modify: `docs/local-offline.md`
- Modify: `docs/local-offline.ko.md`
- Modify: `docs/GBRAIN_VERIFY.md`

- [ ] **Step 1: Update examples and operational guidance**

Make docs consistently say:

- default local model is `nomic-embed-text`
- `nomic` uses `search_document:` and `search_query:` semantics internally
- Postgres upgrades require `gbrain init` then `gbrain embed --all`

- [ ] **Step 2: Run targeted documentation-adjacent tests**

Run:

```bash
bun test test/local-offline.test.ts test/cli.test.ts test/doctor.test.ts
```

Expected: PASS

- [ ] **Step 3: Commit checkpoint**

```bash
git add src/commands/init.ts README.md docs/local-offline.md docs/local-offline.ko.md docs/GBRAIN_VERIFY.md
git commit -m "docs: document nomic embedding migration"
```

### Task 5: Run fresh verification on the integrated change

**Files:**
- Modify: none

- [ ] **Step 1: Run focused regression suite**

Run:

```bash
bun test test/local-offline.test.ts test/config.test.ts test/migrate.test.ts test/doctor.test.ts test/cli.test.ts
```

Expected: PASS

- [ ] **Step 2: Run runtime smoke check against local Ollama**

Run:

```bash
OLLAMA_HOST=http://127.0.0.1:11434 bun test test/local-offline.test.ts
```

Expected: PASS on the updated nomic-related assertions

- [ ] **Step 3: Review the diff for scope control**

Run:

```bash
git status --short
git diff --stat
```

Expected:

- only embedding, migration, tests, and docs related files changed
- no unrelated cleanup

- [ ] **Step 4: Commit integrated work**

```bash
git add src test docs README.md
git commit -m "feat: migrate embeddings to nomic-embed-text"
```
