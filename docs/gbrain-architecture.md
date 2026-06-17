# GBrain Architecture — Memory + Voice Extensions

## Layer Diagram

```
VOICE UI (microphone / audio file)
  │
  ▼
STT ADAPTER (MockSTTAdapter | DeepgramSTTAdapter)
  │  transcribe(audio) → TranscriptionResult { text, segments, language, confidence }
  ▼
VoiceSessionService
  │  processAudio() → transcribe → summarize → synthesize TTS → persist via onSave
  │
  ├──▶ TTS ADAPTER (MockTTSAdapter | SupertonicTTSAdapter)
  │      synthesize(text) → ArrayBuffer (audio output)
  │
  └──▶ onSave hook → GBrain Page (voice_session type, YAML frontmatter)
         │
         ▼
    consolidateVoiceSession()
         │  parseTagEntities("person:alice") → MemoryNode + Relation("mentions")
         ▼
    GRAPH LAYER (GraphRepository interface)
         │  InMemoryGraphAdapter | PostgresGraphAdapter (future)
         │  createEntity / createRelation / getRelatedEntities / traverseGraph
         ▼
    SEARCH ENRICHMENT
         │  enrichWithRelatedMemories() → attach related_memories[] to search results
         ▼
    FRESHNESS LAYER
         │  computeFreshness → status (fresh/aging/stale)
         │  generateDigest → FreshnessDigest (stale_count, aging_count, fresh_count)
         │  runReconcileCheck → ReconcileReport (orphan_page, dangling_link, duplicate_tag)
         ▼
API / MCP LAYER (thin wrappers — no business logic)
         │  src/mcp/server.ts
         │  src/cli.ts / gbrain serve --http
         ▼
    EXISTING CORE
         src/core/engine.ts, postgres-engine.ts, search/hybrid.ts,
         storage.ts, operations.ts, markdown.ts, schema.sql
```

## Module Boundaries

| Layer | Dependencies | Swap mechanism |
|-------|-------------|----------------|
| `src/core/domain.ts` | None | — |
| `src/core/graph/` | domain.ts | `GraphRepository` interface |
| `src/core/freshness/` | domain.ts | — (pure functions) |
| `src/core/voice/` | graph, domain | `STTAdapter`, `TTSAdapter` interfaces |
| API/MCP | core | Constructor injection |

**Core has zero cloud dependencies.** Adapters (Deepgram, Supertonic) live in core
but throw "not implemented" in MVP — the interfaces exist for contract enforcement.
Real providers need only implement `STTAdapter` / `TTSAdapter` and pass them in.

## Key Interfaces

### GraphRepository (`src/core/graph/types.ts`)
```typescript
interface GraphRepository {
  createEntity(node: MemoryNode): Promise<void>;
  createRelation(relation: Relation): Promise<void>;
  getRelatedEntities(slug: string): Promise<Array<{slug; relation_type; direction}>>;
  traverseGraph(slug: string, depth?: number): Promise<GraphTraversalResult>;
  deleteEntity(slug: string): Promise<void>;
  deleteRelation(from: string, to: string, relation_type: string): Promise<void>;
}
```

### STTAdapter (`src/core/voice/stt.ts`)
```typescript
interface STTAdapter {
  transcribe(audio: AudioInput): Promise<TranscriptionResult>;
  isAvailable(): boolean;
}
```

### TTSAdapter (`src/core/voice/tts.ts`)
```typescript
interface TTSAdapter {
  synthesize(text: string, voice?: string): Promise<ArrayBuffer>;
  isAvailable(): boolean;
}
```

## Data Flow — Voice Session

```
Audio ─→ STT ─→ transcript ─→ search enrichment (optional via caller)
                         ─→ summary (first 200 chars)
                         ─→ answer text ─→ TTS ─→ audio ArrayBuffer
                         ─→ buildPageContent() ─→ onSave(slug, content)
                              writes a page with:
                                type: voice_session
                                source: voice
                                confidence: 0.7
                                ## Transcript
                                ## Summary

Later ─→ consolidateVoiceSession(session, graph)
           Parses tags matching /^(person|company|project):(.+)$/
           Creates MemoryNode per entity (confidence 0.6, consent false)
           Creates Relation("mentions") from session slug to entity slug
```

## Freshness Pipeline

```
Page type → getDecayClassForType()
  decision → slow   (365 days)
  meeting  → medium (90 days)
  status   → fast   (30 days)
  deal     → fast   (30 days)
  *        → medium (90 days, default)

Source    → getSourcePrecision()
  voice/meeting    → low  (confidence 0.6)
  document/email   → medium (confidence 0.8)
  linkedin/manual  → high  (confidence 0.9)
  *                → medium (confidence 0.8, default)

FreshnessMeta → computeFreshness()
  days_since_verified < threshold * 0.5  →  fresh
  days_since_verified <= threshold       →  aging
  otherwise                              →  stale

generateDigest(pages) → FreshnessDigest
  stale_count / aging_count / fresh_count
  Items with recommended_action

digestToMarkdown(digest) → Markdown table

runReconcileCheck(pages, graph, links) → ReconcileReport
  orphan_page    — page has no related entities (info)
  dangling_link  — link targets nonexistent slug (warning)
  duplicate_tag  — page has duplicate tag entries (info)
```
