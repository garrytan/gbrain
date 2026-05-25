# transcribe — video/audio → typed brain entries

A gbrain skill that turns a video URL or local file into a structured brain page with key takeaways, entity back-links, and judgment-driven hub-and-spoke filing — in a single command, fully local by default, free.

## Quick start

```bash
# Install deps (one-time)
uv pip install yt-dlp mlx-whisper youtube-transcript-api
# or: pip install yt-dlp mlx-whisper youtube-transcript-api
brew install ffmpeg  # or: apt install ffmpeg

# Try it
python3 skills/transcribe/scripts/extract_transcript.py \
  https://www.youtube.com/watch?v=oIk3R-sMX5o
```

Returns a JSON object with the transcript, title, duration, engine used, and cache path. The calling agent then synthesizes takeaways and files brain entries per `SKILL.md`.

## Why this exists

`media-ingest` is a high-level prose skill that says "transcribe video/audio somehow." This skill is the **somehow** — a working pipeline that:

- Hits YouTube auto-captions first (~2 sec, free) when available
- Falls back to `yt-dlp` + `mlx-whisper` local transcription (~10 min per hour on Apple Silicon)
- Synthesizes takeaways via the calling agent (in-session, no extra API)
- Files into the typed brain graph with judgment-driven hub-and-spoke decisions

## Cost contract

`COST: $0.00` for the default path. No paid transcription API is wired in. If a future flag adds one, the skill emits an explicit cost line and requires confirmation per the brain-ops cost discipline.

## Platform support

- **Apple Silicon (M1/M2/M3/M4)**: native via mlx-whisper, ~36× realtime
- **Other platforms**: see the `transcribe_mlx()` docstring for the `faster-whisper` swap pattern (same return shape, runs on CPU or CUDA)

## Files

- `SKILL.md` — full operating contract (7 phases, cost contract, errors, anti-patterns)
- `scripts/extract_transcript.py` — orchestrator (~280 lines, CLI-callable)
- `README.md` — this file

## Tested smoke paths

- `https://www.youtube.com/watch?v=oIk3R-sMX5o` (80m talk with captions): 3.4s end-to-end
- Same URL with `--force-whisper` (mlx pipeline cold start): 21s including model download
- Re-run on same URL (cache hit): 0.0s

## Related skills

- `media-ingest` — high-level format router (this skill implements its video/audio path)
- `idea-ingest` — for articles, tweets, written content
- `meeting-ingestion` — for meeting transcripts with attendee propagation
- `enrich` — to deepen auto-created entity pages
