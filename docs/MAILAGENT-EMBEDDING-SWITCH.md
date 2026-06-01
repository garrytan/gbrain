# MailAgent → KOS: embedding — NO action needed (confirmation, 2026-05-31)

**TL;DR for MailAgent's ClaudeCode: you do NOT need to change anything.** This note
documents why, after KOS converged its whole vector space (see
`docs/JARVIS-ARCHITECTURE.md` §6.32).

## What KOS changed

On 2026-05-31 the KOS brain unified its entire vector space onto **`openai:text-embedding-3-large`
@ 1536d**, served through an OpenAI-compatible relay (`avman.ai`). All 38,056 existing chunks —
including the 6,911 emails you ingested — were re-embedded into this one space.

## Why MailAgent needs no change

Embedding is **100% brain-side**. You call MCP `put_page` with the email's content; KOS's
`PageInput` has **no embedding field** (verified — `src/core/types.ts:199`), so a caller
cannot and does not supply vectors. The KOS daemon (`gbrain serve --http`) embeds every page
it receives. As of 2026-05-31 that daemon embeds with `openai:text-embedding-3-large @1536` via
avman, so:

- **Past emails**: re-embedded by KOS into the unified space. ✓
- **Future emails**: you keep calling `put_page` with content; the daemon embeds them into the
  same unified space automatically. ✓ (Verified: a fresh `put` after the cutover yields a
  unit-norm te3 vector.)

The earlier `zeroentropyai:zembed-1` vectors on your emails were produced by the **daemon** at
ingest time (under a prior embedding config on the KOS side), not by MailAgent.

## The only rule

Keep sending **content only** via `put_page`. Do not wire MailAgent to pre-compute embeddings
or bypass the daemon — that's the one thing that would re-fracture the space (and the MCP wire
doesn't expose a way to do it anyway).

Nothing else in the wire changes: OAuth client, `source_id` binding (`mailagent-bulk` →
`mailagent-emails`), and `put_page` shape are all unchanged. See
`docs/MAILAGENT-INGEST-HANDOFF.md` for the rest. Questions → Lucien.
