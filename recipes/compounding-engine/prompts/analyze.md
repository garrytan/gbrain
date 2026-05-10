# Compounding Engine — Analyze prompt

You are running the nightly compounding cycle for Sergio's gbrain. Your job is to analyze the brain state and produce concrete improvement proposals.

## Inputs available to you

- Brain DB at `$DATABASE_URL` (Postgres + pgvector). Use `psql` to query.
- Pages last 24h: query `pages WHERE updated_at > NOW() - INTERVAL '24 hours'`.
- Confidence thresholds in `~/.openclaw/skills/gbrain/compound/learning.json`.
- Backup directory: `~/.openclaw/skills/gbrain/compound/backups/<timestamp>/`.

## Categories to detect (only if confidence > skip_below threshold)

1. **people_orphans** — names mentioned in compiled_truth or originals 2+ times without `people/<slug>` page existing.
2. **page_orphans** — pages with NO incoming/outgoing links AND >7 days old (so we don't catch fresh ones still being linked).
3. **knowledge_gaps** — companies/concepts/funds mentioned 3+ times across pages without their own page.
4. **concept_duplication** — originals with embedding cosine similarity > 0.92 (likely same idea, different words).
5. **incomplete_pages** — pages with `LENGTH(compiled_truth) < 100` chars.
6. **archive_decay** — pages updated >90 days ago AND 0 hits in `mcp_request_log` last 30 days.
7. **synthesis_opportunities** — 3+ originals about same theme — propose creating a `concepts/<theme>` consolidation page.

## Output format (strict JSON)

Output ONE JSON object to stdout. NO markdown, NO commentary, NO ```json fences. Just raw JSON:

```
{
  "cycle_at": "<ISO8601 timestamp>",
  "scan_window_hours": 24,
  "proposals": [
    {
      "id": "<uuid>",
      "category": "people_orphans",
      "confidence": 0.85,
      "action": "create_page",
      "slug": "people/mike-shapiro",
      "evidence": "Mentioned 4 times in pages: originals/jason-paperwork, projects/atlas...",
      "prefilled_content": {
        "type": "person",
        "title": "Mike Shapiro",
        "compiled_truth": "Co-Founder & CTO Elafris (insurance AI agents). Austin TX. ..."
      }
    },
    {
      "id": "<uuid>",
      "category": "page_orphans",
      "confidence": 0.78,
      "action": "add_link",
      "from": "originals/insurance-thesis",
      "to": "companies/elafris",
      "link_type": "applies_to",
      "evidence": "originals/insurance-thesis discusses insurance AI; companies/elafris IS insurance AI startup."
    }
  ]
}
```

## Rules

- **Be conservative.** Only propose if evidence is concrete. Sergio reverts noise.
- **No paraphrase of originals.** Preserve exact phrasing if you reference his words.
- **ASCII slugs only.** `sergio-duran`, NOT `sergio-durán`.
- **Use existing types.** Look at `SELECT DISTINCT type FROM pages` to match conventions.
- **Skip categories with confidence < 0.30.** Don't propose at all.
- **Max 10 proposals per cycle.** Quality over quantity.

## Anti-hallucination

- NEVER propose creating a page without concrete evidence (page text where the entity appears).
- NEVER propose archiving without verifying 0 hits in `mcp_request_log`.
- NEVER guess slugs — derive from actual text.
- If you can't find clear opportunities, output an empty proposals array. Better empty than bad.
