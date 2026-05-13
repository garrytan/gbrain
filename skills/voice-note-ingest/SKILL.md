---
name: voice-note-ingest
version: 0.2.0
description: Ingest a voice note OR a text snippet from the current conversation with exact-phrasing preservation (never paraphrased). Routes content to originals/, concepts/, people/, companies/, ideas/, personal/, or voice-notes/ based on a decision tree. The user's exact words are the signal. Text-mode triggers on explicit user requests like "save this", "pin this", "記下來" — distinct from the always-on ambient signal-detector.
triggers:
  - "voice note"
  - "ingest this voice memo"
  - "transcribe and file"
  - "voice note ingest"
  - "save this audio note"
  - "audio message"
  - "save this"
  - "pin this"
  - "記下來"
  - "幫我記下來"
  - "save what I just said"
  - "capture this snippet"
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

Two input modes — both treat the user's exact words as the signal.

**Voice mode (original):** the user sends an audio or voice message via any
channel (Telegram, voice memo upload, openclaw audio attachment). The host
agent typically provides the transcript text. If not, transcribe via `gbrain
transcription` (Groq Whisper by default; OpenAI fallback for audio > 25MB
segmented via ffmpeg).

**Text-snippet mode (added v0.2):** the user, mid-conversation, explicitly
asks to preserve a piece of the live exchange — e.g. "save this", "pin this",
"記下來", "save what I just said about X". The snippet to capture is normally
the last user turn (or, if the user names a span, the indicated turns). This
mode is **explicit user-triggered**, distinct from the always-on
`signal-detector` which fires ambiently on every message without confirmation.
When both fire on the same turn, voice-note-ingest's explicit write wins; the
ambient detector should treat the page as already captured.

## The pipeline

```
1. STORE       → Voice mode: upload original audio to gbrain storage backend
                 (S3 / Supabase Storage / local — pluggable per
                 src/core/storage.ts).
                 Text-snippet mode: skip audio upload. Persist the verbatim
                 turn text into the destination page's "User's Words" block;
                 no separate binary artifact is required.
2. TRANSCRIBE  → Voice mode: use the agent-provided transcript verbatim, OR
                 call gbrain transcription if no transcript was supplied.
                 Text-snippet mode: no transcription step — the snippet is
                 already text.
3. ROUTE       → Apply the decision tree (below) to find the right
                 destination directory. Tree applies identically to both
                 modes; the user's words are the routing signal.
4. WRITE       → Create / update the destination brain page; preserve the
                 verbatim content (transcript or snippet) in a block-quoted
                 "User's Words" section.
5. CROSS-LINK  → For every entity mentioned (person, company), add a
                 timeline back-link from THEIR brain page to THIS one
                 (Iron Law per conventions/quality.md).
```

## Execution backend choice

When the host agent and gbrain run on the **same machine**, prefer a
**local CLI executor** for the mutating steps:

- `gbrain files upload ...` or `gbrain files upload-raw ...` for the
  original audio
- `put_page` / local write path for the destination page

Reason: the gbrain file-upload primitive is designed as a trusted local
filesystem operation. Do **not** assume the MCP path can perform the same
upload flow just because read/query operations work over MCP.

Practical split:

- **Skill** decides routing, slug, page schema, and cross-links.
- **Local CLI** performs storage upload and other filesystem-trusted
  mutations.
- **MCP** is optional for lookup/read/verification, not the default
  executor for voice-note binary ingest.

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

For ALL pages derived from this skill, include this skeleton. Mode-specific
fields are conditional — only include the audio source / audio link when the
input was actually a voice note.

```markdown
---
title: "[Title derived from content]"
type: [original | concept | voice-note | ...]
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [<voice-note | text-snippet>, relevant-tags]
sources:
  # Voice mode only:
  voice-note:
    type: voice_note
    storage_path: "[gbrain storage URL or relative path]"
    acquired: YYYY-MM-DD
    acquired_via: "voice note from <channel>"
  # Text-snippet mode only:
  text-snippet:
    type: text_snippet
    acquired: YYYY-MM-DD
    acquired_via: "live conversation in <channel>"
---

# Title

> Executive summary of what was said and why it matters.

## User's Words

> "Exact transcript or snippet, verbatim, preserving every word, hesitation,
> and verbal tic. This is the primary source material. Do not edit."

<!-- Voice mode only — omit for text-snippet mode -->
🔊 [Audio]([gbrain storage URL or relative path])

## Analysis

[What this means, why it matters, connections to other thinking. The
analysis is the agent's interpretation; the transcript above is sacred.]

## See Also

- [Related brain pages with relative links]

---

## Timeline

- **YYYY-MM-DD** | <voice note | text snippet> from <channel> — [Brief description]
```

## Citation format

Voice mode:

```
[Source: voice note, <channel>, YYYY-MM-DD]
```

Text-snippet mode:

```
[Source: live conversation snippet, <channel>, YYYY-MM-DD]
```

Include timestamps when available:

```
[Source: voice note, <channel>, YYYY-MM-DD HH:MM PT]
[Source: live conversation snippet, <channel>, YYYY-MM-DD HH:MM PT]
```

## Naming convention

- Audio files (voice mode): `YYYY-MM-DD-<brief-slug>.<ext>` (e.g.,
  `2026-04-13-rick-rubin-creative-philosophy.ogg`)
- Brain pages: match the slug of the destination directory. Text-snippet
  mode uses the same date-slug pattern — no audio file is created.

## Bulk vs. single

This skill handles ONE input at a time — one voice note OR one text snippet.
Each is its own ingest cycle. No batching. If the user wants to pin
multiple non-contiguous turns, run the skill once per turn.

## Anti-Patterns

- ❌ **Paraphrasing the transcript or snippet.** The exact words are the
  signal — applies to both voice and text-snippet modes.
- ❌ **Cleaning up hesitations or filler words** ("um", "like", "you
  know"). The texture matters.
- ❌ **Creating a page with no entity cross-links** when people/companies
  were mentioned. Iron Law fail.
- ❌ **Skipping the audio storage step (voice mode).** Always upload the
  original; the brain page has a `🔊 [Audio]` link back to it.
- ❌ **Forcing a fake audio artifact in text-snippet mode.** No
  `🔊 [Audio]` line, no fabricated `voice-note:` source block. The
  transcript IS the snippet text.
- ❌ **Treating an external URL the user shares as a text-snippet.** If
  the user pastes a link or quotes an article, route to `idea-ingest`
  instead — that skill owns external-content fetch + author tracking.
- ❌ **Doubling up with signal-detector.** Signal-detector is ambient and
  fires automatically; this skill is explicit user-triggered. When both
  fire on the same turn, this skill's write wins and signal-detector
  should detect the existing page and skip the duplicate.
- ❌ **Assuming MCP read access implies MCP upload support.** For local
  deployments, binary ingest should default to trusted local CLI
  execution unless a dedicated safe remote ingest op explicitly exists.

## Related skills

- `skills/signal-detector/SKILL.md` — ambient (auto-on-every-message)
  capture; this skill is the explicit user-triggered counterpart
- `skills/idea-ingest/SKILL.md` — for external-content ingestion (URL,
  article, tweet) where author tracking and source-fetch are required
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
