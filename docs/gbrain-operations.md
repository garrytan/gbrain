# GBrain Operations Reference — Memory + Voice Extensions

## Environment Variables

**None.** The new modules use constructor injection exclusively. Existing env
vars (`OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `SUPABASE_*`, `DATABASE_URL`)
remain unchanged.

## Health Check Categories

| Category | Check | Source |
|----------|-------|--------|
| STT adapter | `stt.isAvailable()` | `src/core/voice/stt.ts` |
| TTS adapter | `tts.isAvailable()` | `src/core/voice/tts.ts` |
| Graph repository | `getRelatedEntities()` returns | `src/core/graph/types.ts` |
| Freshness digest | `stale_count / aging_count / fresh_count` ratios | `src/core/freshness/digest.ts` |

## Freshness Digest — JSON Format

```json
{
  "generated_at": "2026-06-17T12:00:00.000Z",
  "stale_count": 3,
  "aging_count": 5,
  "fresh_count": 42,
  "items": [
    {
      "slug": "alice-smith",
      "title": "Alice Smith",
      "status": "stale",
      "days_since_verified": 412.3,
      "recommended_action": "Review and update content, verify sources"
    },
    {
      "slug": "acme-corp-round-b",
      "title": "Acme Corp Round B",
      "status": "aging",
      "days_since_verified": 80.1,
      "recommended_action": "Schedule review within 10 days"
    },
    {
      "slug": "market-overview",
      "title": "Market Overview Q2",
      "status": "fresh",
      "days_since_verified": 12.5,
      "recommended_action": ""
    }
  ]
}
```

Also available as Markdown via `digestToMarkdown(digest)`:
```
| Page | Status | Days Since Verified | Recommended Action |
|------|--------|--------------------:|--------------------|
| Alice Smith (alice-smith) | stale | 412 | Review and update content, verify sources |
| Acme Corp Round B (acme-corp-round-b) | aging | 80 | Schedule review within 10 days |
| Market Overview Q2 (market-overview) | fresh | 13 | — |
```

## Reconcile Report — JSON Format

```json
{
  "timestamp": "2026-06-17T12:00:00.000Z",
  "findings": [
    {
      "severity": "info",
      "category": "orphan_page",
      "slug": "alice-smith",
      "message": "Page \"alice-smith\" has no incoming or outgoing links",
      "suggestion": "Consider adding relations to connect this page to the knowledge graph"
    },
    {
      "severity": "warning",
      "category": "dangling_link",
      "slug": "voice-session-abc123",
      "message": "Link from \"voice-session-abc123\" to \"alice-smith\" points to a non-existent page",
      "suggestion": "Create a page with slug \"alice-smith\" or remove the link"
    },
    {
      "severity": "info",
      "category": "duplicate_tag",
      "slug": "project-omega",
      "message": "Page \"project-omega\" has duplicate tag(s): ai, ai",
      "suggestion": "Remove duplicate tag entries"
    }
  ]
}
```

Three finding categories:
- **orphan_page** (`info`) — page has zero relations in the graph
- **dangling_link** (`warning`) — relation targets a slug with no page
- **duplicate_tag** (`info`) — duplicate entries in a page's tag list
