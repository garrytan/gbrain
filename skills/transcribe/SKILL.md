---
name: transcribe
version: 1.0.0
description: |
  Transcribe video/audio (YouTube URL, generic URL, or local file) and file the
  result into the brain with key takeaways and entity back-links — in a single
  command. Default path is fully local and free: YouTube auto-captions first,
  then yt-dlp + mlx-whisper as fallback. Synthesis runs in the calling agent's
  in-session context. No paid APIs are wired in.

  Concrete implementation of the video/audio branch of `media-ingest`. Use
  directly for video/audio; use `media-ingest` for PDFs, books, screenshots,
  GitHub repos.
triggers:
  - "transcribe this video"
  - "transcribe this"
  - "get the transcript"
  - "video to script"
  - "key takeaways from this talk"
  - pastes a YouTube URL with intent to capture
  - pastes a Vimeo/podcast URL with intent to capture
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - file_upload
mutating: true
---

# Transcribe Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

Concrete implementation of the video/audio branch of [[media-ingest]]. Where `media-ingest` is a high-level router across formats (video, audio, PDF, book, screenshot, repo), `transcribe` is the specific working pipeline for video and audio with:

- Local-first transcription (no paid APIs default)
- Apple Silicon native via mlx-whisper (~36× realtime)
- Judgment-driven hub-and-spoke filing into the typed brain graph
- Mandatory author/entity back-links

## Contract

- Every transcript becomes a brain page in `originals/transcript-<slug>` (the **hub**) with TL;DR, key takeaways, quotes, entity list, and full transcript reference.
- Zero or more **spoke** pages are created based on content shape (see filing decision tree below). Cap of 3 spokes per run.
- Every entity (person/company/project) mentioned with an existing brain page MUST receive a back-link via `add_timeline_entry` or `add_link`.
- Raw transcript is preserved at `<gbrain-cache>/transcribe/<sha1(input)>.txt` before any brain write — so a failed put never loses the artifact.
- Every fact in the analysis carries an inline `[Source: ...]` citation.

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link.
Format: `- **YYYY-MM-DD** | Referenced in [page title](path) — brief context`

## Cost contract

`COST: $0.00, payment: local + calling-agent subscription`. The default path uses youtube-transcript-api (free) → yt-dlp + mlx-whisper local (free). Synthesis runs in the calling agent's session (already-paid subscription). No paid transcription API is invoked. If a future flag adds one, the skill MUST emit `COST: ~$X.XX, payment: <source>` before the call and require user confirmation.

## Dependencies (one-time install)

```bash
# Python deps in an isolated env
uv tool install yt-dlp
uv pip install --python "$(uv python find)" mlx-whisper youtube-transcript-api

# Or via pip if uv isn't installed:
pip install yt-dlp mlx-whisper youtube-transcript-api

# System dep
brew install ffmpeg   # macOS (or: conda install -c conda-forge ffmpeg)
apt install ffmpeg    # Debian/Ubuntu
```

mlx-whisper requires Apple Silicon. On other platforms, swap to `faster-whisper` (in the orchestrator script, change `transcribe_mlx()` to a faster-whisper call — same return shape).

## Phases

### Phase 1: Pre-flight

Confirm:
- `python3` and the Python deps are importable
- `ffmpeg` on PATH
- `/tmp` has ≥2× input size free
- gbrain reachable (1-sec ping)

If any fail, emit a `PREFLIGHT_FAIL:` line with the exact install command and stop. Do not proceed.

### Phase 2: Extract transcript (cheapest path)

| Input | Primary path | Fallback |
|---|---|---|
| YouTube URL | `youtube-transcript-api` (~2 sec, free) | yt-dlp + mlx-whisper |
| Other URL | yt-dlp download → mlx-whisper | n/a |
| Local file | (ffmpeg convert if needed) → mlx-whisper | n/a |

The orchestrator at `scripts/extract_transcript.py` handles dispatch, caching by SHA-1 of input, file-locking (so concurrent runs don't thrash the GPU), exponential backoff retries, and JSON output. Run it as:

```bash
python3 scripts/extract_transcript.py "<input>" [--model small.en|medium] [--force-whisper] [--no-cache]
```

It emits a single JSON object on stdout (schema in the script). Exit codes: `0=ok, 1=user_error, 2=transient, 3=hard_failure`.

If the orchestrator isn't installed (lean install), the calling agent can run the steps inline:

```bash
# YouTube fast path
python3 -c "from youtube_transcript_api import YouTubeTranscriptApi; print(' '.join(s.text for s in YouTubeTranscriptApi().fetch('<video_id>').snippets))"

# Fallback
yt-dlp -x --audio-format mp3 -o /tmp/audio.%(ext)s '<url>'
python3 -c "import mlx_whisper; print(mlx_whisper.transcribe('/tmp/audio.mp3', path_or_hf_repo='mlx-community/whisper-base.en-mlx')['text'])"
```

### Phase 3: Synthesize

The calling agent reads the transcript and produces, in one pass:

1. **Title** — use video metadata if present; else infer.
2. **TL;DR** — one paragraph, max 4 sentences.
3. **Key takeaways** — 5–10 specific bullets. Name frameworks, terms, claims.
4. **Quotes** — 0–5 verbatim, marked `> "..."`. Only quotable lines, no manufactured ones.
5. **Entities** — specific people/companies/projects/products/papers. Skip generic roles.
6. **Content-shape classification** — pick ONE: `talk_podcast_interview` | `tutorial_howto` | `entity_feature` | `original_thinking`. This drives spoke decisions.

### Phase 4: Brain-first entity check

For each entity (cap at 10), call `search(<entity name>)`. Record matches → existing slugs for back-link. Misses → candidates for new pages.

If `search` fails entirely, write the hub WITHOUT back-links and surface "back-link pass deferred" in the chat summary. Never block on back-links.

### Phase 5: File brain entries (judgment, not asking)

**Always write the transcript hub:**

Slug: `originals/transcript-<kebab-slug>` (title kebab-cased, max 50 chars, suffix `-<sha1:8>` if collision).

Schema:

```markdown
---
type: original
title: <Title>
source: 'transcribe skill, <input-url-or-path>, YYYY-MM-DD'
created: <ISO-8601 UTC>
duration_seconds: <from JSON>
engine: youtube-transcript-api | mlx-whisper
content_shape: <from Phase 3>
tags: [transcript, video, <topic-tags>]
---

## TL;DR
<paragraph>

## Key takeaways
- ...

## Quotes
> "..."

## Full transcript
<paste; if >50 KB, reference cache path + first ~1000 chars>

[Source: video at <input>, transcribed via transcribe skill, YYYY-MM-DD]

## Entities mentioned
- [[slug-of-existing-page]] (existing) — one-line role
- New: <Name>, <Name>

## Source
- URL: <input>
- Engine: <engine> (model: <model>)
```

Write via `put_page` (preferred) or `gbrain put originals/transcript-<slug> < /tmp/hub.md` (CLI fallback).

**Conditional spokes (judgment layer):**

| `content_shape` | Spoke action |
|---|---|
| `tutorial_howto` with ≥3 replicable steps | Write `guides/<topic-kebab>` (template, literal example, when, when-not, why-it-works, open-threads, see-also, timeline). Cite hub as evidence. |
| `entity_feature` AND matching page exists | Append timeline entry to entity page: "YYYY-MM-DD — featured in [[transcript-slug]]: <gist>". |
| `entity_feature` AND no matching page | Create entity page first (`people/<name>` / `companies/<slug>` / `projects/<slug>`), then back-link. |
| `original_thinking` with striking idea | Capture as `originals/<vivid-kebab>` preserving exact wording per the ambient-capture rule. Link to hub. |
| `talk_podcast_interview` | Hub only — don't manufacture spokes. (Still create author entity page if missing — that's ambient capture, not a spoke.) |

**Cap: 3 spokes per run.** Surface additional candidates in the chat summary under "candidates not filed."

### Phase 6: Back-links (mandatory)

For every entity page touched, append a timeline entry pointing to the hub:

```
- **YYYY-MM-DD** | Referenced in [[originals/transcript-<slug>]] — <one-line context>
```

Use `add_timeline_entry` (preferred) or re-put the page with the new entry appended.

### Phase 7: Chat summary

Print ONE compact block to the user:

```
📼 <Title>
   <engine> · <duration> · <wall-time>s

TL;DR
<paragraph>

Takeaways
• ...

📥 brain
   hub: originals/transcript-<slug>
   spokes: <slug-1>, <slug-2> (back-linked)
   candidates not filed: <list or none>

📁 Transcript cached: <path>
```

Single screen, scannable. No "I have completed transcribing…" trailing recap.

## Errors & recovery

- **Phase 2 exit_code=3 (hard failure)**: transcript is gone. Tell the user the underlying error and stop. Do NOT attempt brain writes with empty content.
- **Phase 5 brain write failed**: the hub markdown is already on disk at `<cache>/<sha1>.hub.md`. Tell the user: "brain unreachable — transcript cached at <path>. Re-run with the same input to retry the brain write (transcription will be skipped on re-run via cache hit)."
- **Phase 4 returned no matches**: fine — write the hub without back-links. The "Entities mentioned" section still lists candidates for later filing.

## Idempotency

- Audio cached at `/tmp/transcribe/<sha1>.mp3` and transcript at `<cache>/<sha1>.txt`. Re-running on the same input skips both download and transcription; only synthesis + brain write re-execute.
- Hub slug collisions append `-2`, `-3`, etc. Spoke pages either upsert by slug or skip based on a content-hash check.

## Concurrency

mlx-whisper is GPU-bound. Concurrent runs block on a file-lock at `/tmp/transcribe.lock` rather than thrashing the GPU. Other phases (synthesis, brain writes) parallelize normally.

## Telemetry

Each run appends one JSONL line to `<gbrain-cache>/transcribe/telemetry.jsonl`: input, duration, engine, wall-time, success/failure. Lets future audits answer "how often does the YouTube fast path actually hit?"

## Related skills

- [[media-ingest]] — high-level router; delegates video/audio here
- [[idea-ingest]] — for articles, tweets, written content
- [[meeting-ingestion]] — for meeting transcripts with attendee propagation
- [[enrich]] — to deepen the auto-created entity pages after the fact

## Anti-Patterns

- Skipping the transcript hub. The hub is the artifact of record; spokes derive from it.
- Filing under `sources/` because "it's raw transcribed content." Sources is for raw data dumps only — the hub has clear primary subject (the video).
- Manufacturing spokes when content shape is `talk_podcast_interview`. Don't pad the graph.
- Skipping the author/speaker entity page when the speaker is named. The skill MUST create or update it.
- Calling a paid transcription API by default. The skill's contract is local-first, $0. Paid paths require a flag and explicit cost confirmation.
