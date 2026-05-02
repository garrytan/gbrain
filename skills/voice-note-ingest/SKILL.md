---
name: voice-note-ingest
version: 0.1.0
description: Ingest a voice note with exact-phrasing preservation (never paraphrased). Routes content to originals/, concepts/, people/, companies/, ideas/, personal/, or voice-notes/ based on a decision tree. The user's exact words are the signal.
triggers:
  - "voice note"
  - "ingest this voice memo"
  - "transcribe and file"
  - "voice note ingest"
  - "save this audio note"
mutating: true
writes_pages: true
writes_to:
  - voice-notes/
  - originals/
  - concepts/
  - people/
  - companies/
  - ideas/
  - personal/
---

# voice-note-ingest — Exact-Phrasing Voice Capture

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules, back-link enforcement, and exact-phrasing requirements.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) for
> the filing decision protocol.

## Iron Law

The user's **exact words** are the insight. Never paraphrase. Never clean
up. The vivid, unpolished, stream-of-consciousness phrasing captures
something that cleaned-up prose does not. Preserve it in block quotes.
The Analysis section can interpret; the transcript section is sacred.

- ✅ `"The ambition-to-lifespan ratio has never been more fucked"`
- ❌ `User noted the tension between ambition and mortality`

## When to invoke

The user sends an audio or voice message via any channel (Telegram, voice
memo upload, openclaw audio attachment). The host agent typically provides
the transcript text. If not, transcribe via `gbrain transcription` (Groq
Whisper by default; OpenAI fallback for audio > 25MB segmented via ffmpeg).

## The pipeline

```
1. STORE       → Upload original audio to gbrain storage backend
                 (S3 / Supabase Storage / local — pluggable per
                 src/core/storage.ts).
2. TRANSCRIBE  → Use the agent-provided transcript verbatim, OR call
                 gbrain transcription if no transcript was supplied.
3. ROUTE       → Apply the decision tree (below) to find the right
                 destination directory.
4. WRITE       → Create / update the destination brain page; preserve the
                 verbatim transcript in a block-quoted "User's Words"
                 section.
5. CROSS-LINK  → For every entity mentioned (person, company), add a
                 timeline back-link from THEIR brain page to THIS one
                 (Iron Law per conventions/quality.md).
```

## Decision tree (where the content goes)

Apply in order. First match wins. If multiple categories apply, file to
the primary directory and cross-link to the others.

1. **Original idea, observation, or thesis** — the user is expressing a
   novel thought, framework, or connection THEY generated.
   → `originals/<slug>.md`. Use the user's vivid language for the slug.

2. **About a world concept they encountered** — a framework or model
   someone else created that the user is referencing.
   → `concepts/<slug>.md`.

3. **About a specific person** — new information, opinion, or observation
   about someone.
   → Update `people/<person>.md` timeline.

4. **About a specific company** — new info about a company.
   → Update `companies/<company>.md` timeline.

5. **A product or business idea** — something that could be built.
   → `ideas/<slug>.md`.

6. **A personal reflection** — therapy-adjacent, emotional, identity.
   → Append to appropriate `personal/<slug>.md`.

7. **None of the above / random thought / doesn't fit cleanly** —
   → `voice-notes/YYYY-MM-DD-<slug>.md` (catch-all).

**Multiple categories?** Create the primary page, then cross-link to all
others. If the voice note covers a person AND a novel idea, create the
originals/ page AND update the person's timeline.

## Brain page format

For ALL voice-note-derived pages, include this skeleton:

```markdown
---
title: "[Title derived from content]"
type: [original | concept | voice-note | ...]
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [voice-note, relevant-tags]
sources:
  voice-note:
    type: voice_note
    storage_path: "[gbrain storage URL or relative path]"
    acquired: YYYY-MM-DD
    acquired_via: "voice note from <channel>"
---

# Title

> Executive summary of what was said and why it matters.

## User's Words

> "Exact transcript, verbatim, preserving every word, hesitation, and verbal
> tic. This is the primary source material. Do not edit."

🔊 [Audio]([gbrain storage URL or relative path])

## Analysis

[What this means, why it matters, connections to other thinking. The
analysis is the agent's interpretation; the transcript above is sacred.]

## See Also

- [Related brain pages with relative links]

---

## Timeline

- **YYYY-MM-DD** | voice note from <channel> — [Brief description]
```

## Citation format

```
[Source: voice note, <channel>, YYYY-MM-DD]
```

Include timestamps when available:

```
[Source: voice note, <channel>, YYYY-MM-DD HH:MM PT]
```

## Naming convention

- Audio files: `YYYY-MM-DD-<brief-slug>.<ext>` (e.g.,
  `2026-04-13-rick-rubin-creative-philosophy.ogg`)
- Brain pages: match the slug of the destination directory.

## Bulk vs. single

This skill handles ONE voice note at a time. Each is its own ingest cycle.
No batching.

## Anti-Patterns

- ❌ **Paraphrasing the transcript.** The exact words are the signal.
- ❌ **Cleaning up hesitations or filler words** ("um", "like", "you
  know"). The texture matters.
- ❌ **Creating a page with no entity cross-links** when people/companies
  were mentioned. Iron Law fail.
- ❌ **Skipping the audio storage step.** Always upload the original; the
  brain page has a `🔊 [Audio]` link back to it.

## Related skills

- `skills/signal-detector/SKILL.md` — same exact-phrasing pattern for
  text-channel idea capture
- `skills/idea-ingest/SKILL.md` — for typed-text idea ingestion
- `skills/conventions/quality.md` — citation + back-link rules


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
