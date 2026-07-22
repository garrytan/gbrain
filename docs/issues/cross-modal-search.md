# Cross-Modal Search: Text↔Image Retrieval

## Summary

gbrain has a working multimodal embedding pipeline (Voyage multimodal-3, `embedding_image` column, 11K image chunks indexed) but search is siloed: text queries only search text embeddings, image queries don't exist. This proposal adds cross-modal query routing so text queries can surface images and image queries can surface text, using Voyage multimodal-3's shared embedding space.

## Problem

**What the user sees:** You can't search "photos from the hackathon" and get actual images. You can't upload a photo and ask "what do we know about this person?" Text search returns text. Image embeddings sit unused except via explicit `embeddingColumn: 'embedding_image'` override, which no user-facing path triggers.

**What the system does:**
- Text queries embed through the configured text model (OpenAI/ZE) and search the text column
- The `embedding_image` column exists (Voyage multimodal-3, 1024d) with 11,204 embedded chunks and a valid 83 MB HNSW index
- `postgres-engine.ts:searchVector()` supports `embeddingColumn: 'embedding_image'` but the query vector must come from a compatible model (Voyage multimodal, 1024d)
- Currently, `embedQuery()` always uses the text embedding model, producing a 1536d or 2560d vector that can't query the 1024d image column

**What it should do:**
1. Detect cross-modal intent in a search query ("show me photos of...", "find images from...", or explicit image search flag)
2. Embed the text query through Voyage multimodal-3 (same model used for image embeddings)
3. Search the `embedding_image` column with the multimodal query vector
4. Return image results alongside or instead of text results
5. Support image-as-query: accept an image input, embed it through Voyage multimodal-3, search text embeddings (if a shared multimodal column exists) or the image column

## Evidence

### Image embeddings exist and are indexed

```sql
-- Production state (May 2026)
SELECT COUNT(*) FROM content_chunks WHERE embedding_image IS NOT NULL;
-- 11,204

SELECT indexrelid::regclass, indisvalid, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_index WHERE indrelid = 'content_chunks'::regclass
AND indexrelid::regclass::text LIKE '%image%';
-- idx_chunks_embedding_image | true | 83 MB
```

### Modality metadata is broken

```sql
SELECT COUNT(*) FROM content_chunks WHERE modality = 'image';
-- 10 (should be ~11,204)
```

Most image chunks have `embedding_image IS NOT NULL` but `modality` is not set to `'image'`. This is a backfill gap from the v0.27.1 migration.

### Voyage multimodal-3 is cross-modal by design

From Voyage docs: voyage-multimodal-3 encodes text, images, and interleaved text+image into the same 1024-dimensional vector space. A text query embedded through this model can find relevant images, and vice versa. gbrain already uses it for the image column but never for query embedding.

### Search routing is text-only

`hybrid.ts` line ~414:
```typescript
const embeddings = await Promise.all(queries.map(q => embedQuery(q)));
```

`embedQuery()` always uses the global text model. No path exists to embed a text query through the multimodal model for cross-modal search.

## Proposed Fix

### Phase 1: Text → Image Search

**1. Cross-modal intent detection** (new file: `src/core/search/cross-modal.ts`)

Add a lightweight intent classifier that detects when a query is looking for images:

```typescript
function detectCrossModalIntent(query: string): 'text' | 'image' | 'both' {
  // Explicit image patterns
  const imagePatterns = [
    /\b(show|find|get)\s+(me\s+)?(photos?|images?|pictures?|screenshots?)/i,
    /\bwhat\s+does\s+.+\s+look\s+like/i,
    /\b(whiteboard|diagram|slide|screenshot)\b/i,
    /\bphoto(s)?\s+(of|from|at|with)\b/i,
  ];
  if (imagePatterns.some(p => p.test(query))) return 'image';
  return 'text'; // Default: text-only
}
```

**2. Multimodal query embedding** (extend `embedding.ts`)

Add `embedQueryMultimodal(text: string): Promise<Float32Array>` that routes through the configured multimodal model (Voyage multimodal-3) instead of the text model.

```typescript
export async function embedQueryMultimodal(text: string): Promise<Float32Array> {
  // Use the multimodal provider, not the text provider
  return gatewayEmbedQuery(text, { provider: cfg.embedding_multimodal_model });
}
```

**3. Hybrid search routing** (extend `hybrid.ts`)

When cross-modal intent is detected:
- Embed query through multimodal model (Voyage multimodal-3, 1024d)
- Search `embedding_image` column
- Return results with a `modality: 'image'` tag
- If intent is `'both'`: run text search AND image search, merge with RRF

**4. SearchOpts extension** (extend `types.ts`)

```typescript
interface SearchOpts {
  // ... existing fields
  crossModal?: 'text' | 'image' | 'both' | 'auto';  // Default: 'auto' (intent detection)
}
```

### Phase 2: Image → Text Search (future)

Accept an image buffer/URL as search input. Embed through Voyage multimodal-3. Search text embeddings. This requires a new search entry point (`searchByImage`) and MCP tool exposure. Defer to a follow-up PR.

### Phase 3: Unified Multimodal Column (future)

Embed ALL content (text + images) through Voyage multimodal-3 into a single column. This creates a truly unified search space but doubles embedding costs and requires re-embedding all text. Evaluate after Phase 1 results.

## Backfill: Fix modality metadata

Before cross-modal search is useful, fix the modality column:

```sql
-- Chunks with image embeddings but wrong modality
UPDATE content_chunks
SET modality = 'image'
WHERE embedding_image IS NOT NULL AND (modality IS NULL OR modality != 'image');
```

This is a prerequisite for Phase 1 since result display needs to know which chunks are images.

## Test Guidance

### Red tests (should fail before fix, pass after)

1. **Intent detection:** `detectCrossModalIntent("show me photos from the hackathon")` returns `'image'`.
2. **Intent detection negative:** `detectCrossModalIntent("what is founder mode?")` returns `'text'`.
3. **Multimodal embed routing:** `embedQueryMultimodal("hackathon")` returns a 1024d vector (Voyage multimodal dims), not 1536d or 2560d.
4. **Cross-modal search:** `hybridSearch("show me hackathon photos", { crossModal: 'image' })` returns results from the `embedding_image` column.
5. **Default behavior unchanged:** `hybridSearch("what is founder mode?")` returns text results as before (no cross-modal unless detected).
6. **Explicit override:** `hybridSearch("anything", { crossModal: 'image' })` forces image search regardless of intent detection.

### Edge cases

- Query matches image intent but no image embeddings exist for the topic: return empty image results, fall back to text.
- Multimodal model not configured: skip cross-modal, log warning, return text results.
- Mixed results ('both' mode): text and image results merged, each tagged with modality for display.

## Related Context

- PR #1106 adds dynamic text embedding column selection (prerequisite: the `embedding_columns` registry and provider routing from that PR make this easier to implement)
- v0.27.1 introduced the dual-column schema (`embedding` + `embedding_image`)
- `importImageFile` in `postgres-engine.ts` handles image ingestion and multimodal embedding
- Voyage multimodal-3 is already configured as `embedding_multimodal_model` in gbrain config
- The image OCR pipeline (`embedding_image_ocr: true`) extracts text from images before embedding, so image chunks have both visual and text representation

## Phasing

| Phase | Scope | Effort | Value |
|---|---|---|---|
| **1 (this PR)** | Text → Image search with intent detection | Medium | High — unlocks "find photos" queries |
| 2 | Image → Text search (upload photo, find related text) | Medium | Medium — cool but niche use case |
| 3 | Unified multimodal column (everything in one space) | Large | High — but expensive and requires re-embedding |
| Prereq | Fix modality column backfill | Small | Required for Phase 1 |
