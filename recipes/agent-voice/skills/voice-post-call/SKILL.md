---
name: voice-post-call
version: 0.1.0
description: Post-call handling for a voice session — turn the transcript into a brain page, post the summary to the operator's messaging surface, archive the audio. The pipeline is the contract; the firing paths are operator-wired (see "Two firing paths" below for what ships today).
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

> **Convention:** see gbrain's `skills/conventions/quality.md` for citation rules + back-link enforcement, and `skills/_brain-filing-rules.md` for the filing decision protocol. (These are not copied by the install; the relative paths resolve only if your host repo mirrors gbrain's skills layout.)

## Iron Law

**Every call gets processed, even on tool-call failure.** The voice persona MAY log mid-session via an opted-in write tool, OR the call may end without that tool firing (model forgot, WebRTC dropped, browser crashed). A call-end handler should post a structured signal regardless so the brain still gets the transcript + audio reference — see "Two firing paths" below for which of these ships today and which the operator implements.

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

## Two firing paths (both operator-wired today)

**Path A — Persona-initiated mid-call (opt-in):**
The voice persona calls `log_to_brain` via the WebRTC data channel; the host-repo `/tool` endpoint dispatches through `tools.mjs`. `log_to_brain` is in `OPTIONAL_OPS`, not `READ_ONLY_OPS`, so this only works if the operator's `tools-allowlist.local.json` opts in (there is no `log_call_summary` tool — the override can only enable ops listed in `OPTIONAL_OPS`).

**Path B — Call-end handler (not yet shipped):**
The shipped `server.mjs` has **no automatic call-end handler** — nothing fires when the WebSocket / WebRTC connection closes. To get the safety-net behavior, implement a post-call handler in your host repo that reads the captured audio + transcript on connection close and runs the pipeline above. Until you do, Path A (opt-in) is the only firing path, and calls where the persona never logs are NOT processed.

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

Ships with this bundle (sibling directories after install):

- [voice-persona-mars](../voice-persona-mars/SKILL.md) — the persona that may invoke this
- [voice-persona-venus](../voice-persona-venus/SKILL.md) — the other persona that may invoke this

Lives in gbrain's `skills/` (present on the host only if your repo mirrors gbrain's skills layout):

- `meeting-ingestion` — analogous flow for multi-party meeting transcripts (different in that voice-call is typically 1:1)
- `media-ingest` — for recorded one-way voice memos (different from live voice calls)

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
