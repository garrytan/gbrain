# GBrain Voice — Setup & Operations

## Quick Start (Mocks)

```typescript
import { MockSTTAdapter, MockTTSAdapter, VoiceSessionService } from './src/core/voice/index.ts';

const stt = new MockSTTAdapter({ delayMs: 50 });         // option: fail: true
const tts = new MockTTSAdapter({ delayMs: 30 });          // option: fail: true

let savedSlug = '';
const service = new VoiceSessionService({
  stt,
  tts,
  onSave: async (page) => { savedSlug = page.slug; },
});

const audio = { buffer: new ArrayBuffer(0), mimeType: 'audio/wav' };
const result = await service.processAudio(audio, { tags: ['person:alice'] });
// result: { sessionId, transcript, summary, tags, audioOutput, pageContent }
```

## Configuration

| Adapter | Constructor | Notes |
|---------|-------------|-------|
| `MockSTTAdapter` | `(opts?: { delayMs?, fail?, language? })` | Returns canned transcript "This is a mock transcription..." |
| `MockTTSAdapter` | `(opts?: { delayMs?, fail? })` | Returns 64-byte empty ArrayBuffer |
| `DeepgramSTTAdapter` | `(apiKey: string)` | `transcribe()` throws in MVP — implement the call |
| `SupertonicTTSAdapter` | `(baseUrl?: string)` | Default `http://localhost:8080/v1`; `synthesize()` throws in MVP |

**No env vars required.** Adapters use constructor injection. The mock adapters
work out of the box — no keys, no network.

## Voice Session Lifecycle

```
1. processAudio(audio, context?)
   ├── stt.transcribe(audio)     → transcript text
   ├── generateSummary(text)     → first 200 chars (or full if ≤200)
   ├── build answer text          → "I processed your input about: {first 100 chars}"
   ├── tts.synthesize(answer)    → audio ArrayBuffer (empty on failure)
   ├── buildPageContent()        → markdown with YAML frontmatter
   └── onSave({slug, content})   → caller persists the page
```

Page frontmatter:
```yaml
---
type: voice_session
source: voice
confidence: 0.7
consent: true
slug: "voice-session-{timestamp}-{random}"
title: "Voice Session"
tags: ["person:alice"]
---

## Transcript
... raw transcription ...

## Summary
... first 200 chars ...
```

## Consolidation Rules

Call `consolidateVoiceSession(session, graph)` after the session is persisted.

Tag parsing — only tags matching `^(person|company|project):(.+)$` are extracted:

| Tag pattern | MemoryType | Example |
|-------------|-----------|---------|
| `person:Alice Smith` | `person` | slug `alice-smith` |
| `company:Acme Corp` | `company` | slug `acme-corp` |
| `project:Omega` | `project` | slug `omega` |

For each matched tag:
1. **Create entity** via `graph.createEntity()` — confidence 0.6, consent false
2. **Create relation** `sessionSlug → mentions → entitySlug` — confidence 0.6

If no tags match, consolidation returns empty (`{ entities: [], relations: [] }`).
Failed entity/relation writes log a console.error and continue; one failure does
not abort remaining tags.
