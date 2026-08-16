---
name: media-ingest
version: 1.1.0
description: |
  Ingest video, audio, PDF, book, screenshot, and GitHub repo content into the brain.
  Multi-format handling with entity extraction and backlink propagation. Covers
  video-ingest, youtube-ingest, and book-ingest subtypes.
triggers:
  - "watch this video"
  - "process this YouTube link"
  - "ingest this PDF"
  - "save this podcast"
  - "process this book"
  - "PDF book"
  - "summarize this book"
  - "ingest it into my brain"
  - "what's in this screenshot"
  - "check out this repo"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - file_upload
mutating: true
writes_pages: true
writes_to:
  - concepts/
  - people/
  - companies/
  - sources/
upstream: media-ingest@fc834ee
---

# Media Ingest Skill

Ingest video, audio, PDF, book, screenshot, and GitHub repo content into the brain.

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Input

| Parameter | Required | Description |
|-----------|----------|-------------|
| source | yes | URL, file path, or uploaded file reference |
| title | no | Override title (auto-detected if omitted) |
| target_slug | no | Override page slug (auto-generated if omitted) |

## Contract

This skill guarantees:
- Every ingested media item has a brain page with analysis (not just a transcript dump)
- Transcripts (video/audio) saved in raw and human-readable formats
- Entity extraction: every person and company mentioned gets back-linked
- Raw source files preserved via `gbrain files upload-raw`
- Filing by primary subject, not by media format

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every mention of a person or company with a brain page MUST create a back-link.

## Phases

### Phase 1: Identify format and fetch

| Format | Action |
|--------|--------|
| YouTube/video URL | Fetch transcript (Whisper, transcription service, or captions) |
| Audio file | Transcribe with available STT service |
| PDF | Extract text (OCR if needed) |
| Book PDF | Extract text, identify chapters/sections |
| Screenshot/image | OCR via vision model, extract text and entities |
| GitHub repo | Clone, read README + key files, summarize architecture |

### Phase 2: Upload raw source

Save the original file for provenance: `gbrain files upload-raw <file> --page <slug>`

### Phase 3: Create brain page

File by primary subject (not format). Use this template:

```markdown
# {Title}

**Source:** {URL or file path}
**Format:** {video/audio/PDF/book/screenshot/repo}
**Created:** {date}

## Summary
{Key points, not a transcript dump}

## Key Segments / Highlights
{For video/audio: timestamped highlights. For books: chapter summaries.}

## People Mentioned
{List with links to brain pages}

## Companies Mentioned
{List with links to brain pages}
```

### Phase 4: Entity extraction and propagation

For every person and company mentioned:
1. Check brain for existing page
2. Create/enrich if needed (delegate to enrich skill)
3. Add back-link from entity page to this media page
4. Add timeline entry on entity page

A media item is NOT fully ingested until entity propagation is complete.

### Phase 5: Sync

`gbrain sync` to update the index.

## Output Format

Brain page created with summary, highlights, and entity cross-links. Report to user:
"Ingested {title}: {N} entities detected, {N} pages updated."

## Error Handling

- **Transcription failure:** If STT or captions are unavailable, note `[transcript unavailable]` in the page and proceed with whatever metadata is available. Do NOT fabricate content.
- **Duplicate detection:** Before creating a page, search the brain for the source URL or file hash. If found, ask the user whether to update the existing page or skip.
- **Partial OCR / audio:** Mark unclear segments with `[inaudible]` or `[illegible]`. Never guess at proper nouns.
- **Large content (books > 500 pages):** Summarize by chapter; do not attempt to inline the full text. Link to the raw upload.
- **Retry policy:** On transient API failures (network, timeout), retry once. On auth failures, abort immediately.

## Known Pitfalls

1. **YouTube auto-captions misidentify proper nouns.** Always cross-reference entity names against existing brain pages before creating new ones. A caption that garbles a name (e.g. "Alise" when the speakers are discussing alice-example) should match the existing `alice-example` page, not create a new one.
2. **Re-running ingest on same source creates duplicates.** Always check brain for existing source URL match before Phase 3.
3. **Book OCR quality varies wildly.** Scanned PDFs often have garbled text. If OCR quality is <80% readable, flag to user rather than ingesting garbage.
4. **Video transcript without speaker diarization is low-value.** If multiple speakers are present but no diarization is available, note this limitation prominently rather than attributing all speech to one person.
5. **Large audio files (>2hr) can timeout transcription services.** Split into chunks before transcription if needed.

## Anti-Patterns

- Dumping raw transcripts without analysis
- Skipping entity extraction ("I'll do that separately")
- Filing **raw ingest** by format (all videos in `media/videos/`) instead of by subject. Note: format-prefixed paths under `media/<format>/<slug>` ARE sanctioned for **synthesized one-of-one output** like book-mirror's `media/books/<slug>-personalized.md`. The anti-pattern is for raw ingest, not for sui generis synthesis. See `skills/_brain-filing-rules.md` "Sanctioned exception: synthesis output is sui generis."
- Not preserving raw source files
- Creating stub pages without meaningful content
