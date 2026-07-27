---
name: voice-post-call
version: 0.1.0
description: Post-call handling for a voice session — turn the transcript into a brain page, post the summary to the operator's messaging surface, archive the audio. Belt-and-suspenders: fires both from a tool the voice persona can call mid-call AND from the automatic call-end handler in server.mjs.
triggers:
  - "after the call"
  - "call ended"
  - "summarize the call"
  - "call transcript"
  - "voice call summary"
  - "post call summary"
mutating: true
writes_pages: true
writes_to:
  - meetings/
  - voice-calls/
---

# voice-post-call — Post-session transcript + summary handling

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for citation rules + back-link enforcement.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) for filing decision protocol.

## Iron Law

**Every call gets processed, even on tool-call failure.** The voice persona MAY call a `log_call_summary` tool mid-session, OR the call may end without that tool firing (model forgot, WebRTC dropped, browser crashed). The automatic call-end handler in `services/voice-agent/code/server.mjs` posts a structured signal regardless so the brain still gets the transcript + audio reference.

If both paths fire (the tool call AND the call-end handler), the second one is idempotent — it sees the brain page already exists and updates instead of duplicating.

## The pipeline

```
1. CAPTURE  → MediaRecorder on the host repo's voice-agent service captures
              the full call audio (webm/opus) to /tmp/calls/<ts>-<persona>.webm.
              The browser client at /call?test=1 also captures via WebAudio-tee
              for E2E asserts; production /call uses server-side capture only.
2. TRANSCRIBE → Whisper (via gbrain transcription) processes the audio. Output:
              full transcript (timestamped) + speaker labels where possible.
3. SUMMARIZE  → A separate LLM call produces a 3-5 sentence summary covering
              key topics, decisions, and unresolved items.
4. WRITE      → Create or update meetings/YYYY-MM-DD-call-<persona>.md with:
              - frontmatter (date, persona, duration, ratings)
              - full transcript in a "Transcript" block-quote section
              - summary in a "Summary" section
              - audio link (file://, or signed URL if uploaded to storage)
              - any entity cross-links (people, companies mentioned)
5. CROSS-LINK → For each entity in the transcript (person, company), append a
              timeline entry to people/<slug>.md or companies/<slug>.md pointing
              back to this call page. Iron Law: per conventions/quality.md.
6. POST       → Send the summary to the operator's messaging surface (Telegram,
              Slack, Discord — whichever is wired in $TARGET_REPO/.env).
```

## Two firing paths (belt + suspenders)

**Path A — Persona-initiated mid-call:**
The voice persona calls `log_call_summary` via the WebRTC data channel. The host-repo `/tool` endpoint dispatches to `tools.mjs`. Note: `log_call_summary` is in `OPTIONAL_OPS`, not `READ_ONLY_OPS`, so this only works if the operator's `tools-allowlist.local.json` opts in.

**Path B — Automatic call-end (default):**
When the WebSocket / WebRTC connection closes, `server.mjs` fires a `call_end` event. The host repo's post-call handler (operator-implemented; the recipe ships a stub) reads the captured audio + transcript, runs the pipeline above. This path requires NO operator opt-in to work — the call-end handler is part of the shipped server.

## Brain page format

```markdown
---
type: meeting
subtype: voice-call
persona: venus
date: 2026-05-17
duration_sec: 124
caller: operator
rating: 7
issues: []
audio_url: "file:///tmp/calls/2026-05-17-1029-venus.webm"
created: 2026-05-17
---

# Voice call: 2026-05-17 with Venus

> Brief 3-5 sentence summary of what was discussed and any decisions made.

## Summary
[Agent-authored 3-5 sentence summary covering topics, decisions, action items.]

## Transcript

> [Verbatim per-turn transcript with speaker labels and timestamps. Pure quote
> — do not paraphrase. Block-quoted because the exact wording matters more
> than a cleaned-up version.]

🔊 [Audio](file:///tmp/calls/2026-05-17-1029-venus.webm)

## Entities mentioned
- [Person](people/<slug>.md)
- [Company](companies/<slug>.md)

## Timeline

- **2026-05-17 10:29 PT** | voice call with Venus, 124s, rating 7 — [topic]
```

## Citation format

```
[Source: voice call with <persona>, YYYY-MM-DD HH:MM PT]
```

## Anti-patterns

- ❌ Paraphrasing the transcript. The verbatim text IS the signal; the summary is the agent's interpretation.
- ❌ Skipping the audio archive step. Every call has a recoverable audio file.
- ❌ Skipping entity cross-links when people/companies are mentioned. Iron Law fail.
- ❌ Posting to messaging WITHOUT writing the brain page first. The messaging summary is a notification, not the canonical record.
- ❌ Letting Path A's success suppress Path B. They MAY both fire; the second one is idempotent and serves as a redundant safety net.

## Related skills

- [voice-persona-mars](../voice-persona-mars/SKILL.md) — the persona that may invoke this
- [voice-persona-venus](../voice-persona-venus/SKILL.md) — the other persona that may invoke this
- [meeting-ingestion](../meeting-ingestion/SKILL.md) — analogous flow for multi-party meeting transcripts (different in that voice-call is typically 1:1)
- [voice-note-ingest](../voice-note-ingest/SKILL.md) — for recorded one-way voice memos (different from live voice calls)

## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- The post-call pipeline runs idempotently — second invocations update rather than duplicate.
- Output written under `meetings/` or `voice-calls/` (consistent with `_brain-filing-rules.md`).
- Conventions referenced (`quality.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names in any committed sample; the operator's actual call transcripts contain whatever they say, which is the operator's data and not gbrain's concern.

## Output Format

```markdown
---
type: meeting
subtype: voice-call
persona: <mars|venus>
date: YYYY-MM-DD
duration_sec: N
caller: <identity>
rating: 0-10
audio_url: "<file:// or signed URL>"
---

# Voice call: <date> with <persona>

> <Summary>

## Summary
<body>

## Transcript

> <verbatim>

🔊 [Audio](<url>)

## Timeline

- **<date> <time> <tz>** | voice call with <persona>, <duration>s — <topic>
```
