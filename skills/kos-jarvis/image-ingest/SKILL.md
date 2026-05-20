---
name: image-ingest
description: Daily cron that scans IMAGE_SOURCE_DIR, imports new images (jpg/png/heic/webp/gif) into gbrain via importImageFile, embeds them through Voyage multimodal-3 (1024d), and writes them as pages with cross-modal search capability (gbrain search --image).
triggers:
  - "ingest images"
  - "image ingest"
  - "scan image dir"
status: scaffolded — needs VOYAGE_API_KEY + IMAGE_SOURCE_DIR set before bootstrap
---

# image-ingest — scaffold

Wraps `gbrain import <IMAGE_SOURCE_DIR>` for the v0.36.6.0 cross-modal
search wave. Routed to `importImageFile` when `GBRAIN_EMBEDDING_MULTIMODAL=true`
+ recognized extension (.jpg/.jpeg/.png/.heic/.webp/.gif/.tif/.tiff). Each
image becomes a page with `kind=source` + `embedding_multimodal vector(1024)`
populated via Voyage multimodal-3.

## Pre-bootstrap setup (Lucien manual, one-time)

1. **Register Voyage account + get API key** at https://www.voyageai.com.
   Free tier covers ~50M tokens; multimodal-3 is $0.05/M tokens. Pilot
   batch of ~500 images ≈ $0.05.

2. **Curate IMAGE_SOURCE_DIR**. Examples:
   - `~/jarvis-images/` — manually drop screenshots / charts / photos
     worth indexing
   - `~/Downloads/notion-r5a-capture/` — already on disk from prior export
   - or any dir that has stable, append-mostly image content (NOT
     `~/Pictures/` if it points to Photos.app library — those are not
     individually addressable)

3. **Fill plist template** at
   `scripts/launchd/com.jarvis.image-ingest.plist.template`:
   - Replace `<FILL:VOYAGE_API_KEY>` with real key
   - Replace `<FILL:IMAGE_SOURCE_DIR>` with absolute path
   - Copy to `~/Library/LaunchAgents/com.jarvis.image-ingest.plist`

4. **Bootstrap**:
   ```bash
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.jarvis.image-ingest.plist
   ```

5. **First manual kick**:
   ```bash
   launchctl kickstart -k gui/$UID/com.jarvis.image-ingest
   tail -50 skills/kos-jarvis/image-ingest/image-ingest.stdout.log
   ```

## Cron contract

- **Schedule**: daily 04:30 local (between dream-cycle 03:11 and
  kos-patrol 08:07, off thundering-herd minute marks).
- **Command**: `bun run skills/kos-jarvis/image-ingest/run.ts`
- **Behavior**: walks `IMAGE_SOURCE_DIR` recursively, dispatches each
  image extension via `gbrain import <dir>` (gbrain's walker auto-detects
  image extensions when `GBRAIN_EMBEDDING_MULTIMODAL=true`). Skips files
  already imported (gbrain's idempotency via content_hash).
- **Exit code**: 0 = clean / ok, 1 = some import failures, 2 = wrapper
  error (binary missing, dir not readable).
- **Log archive**: `~/brain/.agent/image-ingest/<ISO>.json` records
  imported count + cost estimate. `latest.json` symlink for /status.

## Spend monitoring

Voyage multimodal-3 at $0.05/M tokens. Per-image typical: ~300-800 tokens
(image patches + caption tokenization). 100 image batch ≈ $0.015. Cron
log line includes `cost_usd_estimate`.

If monthly spend > $5 unexpectedly: check `~/brain/.agent/image-ingest/latest.json`
for `imported_count` (Voyage quotas per-account so spend can't run away
silently).

## After first successful run

Verify multimodal column populated:

```bash
psql -h 127.0.0.1 -U chenyuanquan -d gbrain -c \
  "SELECT COUNT(*) FROM content_chunks WHERE embedding_multimodal IS NOT NULL;"
```

Test cross-modal query:

```bash
bin/gbrain search "hackathon photos" 2>&1 | head
bin/gbrain query "what charts did I capture from acme corp?" 2>&1 | head
```

## Re-evaluate triggers

- VOYAGE_API_KEY rotated → update plist + bootout/bootstrap
- IMAGE_SOURCE_DIR moved or grew unwieldy (>10K images) → consider
  per-day batching via cron interval bump or per-image-source plist split
- Voyage SLA degradation or price change → evaluate alternative
  embedder (CLIP local? Gemini multimodal embed?)
- Lucien stops adding new images for 30 days → consider deactivating
  the cron, keep retroactive `gbrain reindex --multimodal` ad-hoc

## Status

**Scaffolded 2026-05-19** post v0.37.0.0 sync (per TODO L177 P1 +
JARVIS-ARCHITECTURE §6.29 Followup F decision (a) "Full enable + cron").
Awaits VOYAGE_API_KEY + IMAGE_SOURCE_DIR fill before bootstrap.
