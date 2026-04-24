# Gmail Archive Backfill

Importing decades of Gmail into gbrain without burning a month's OpenAI budget.

The live `email-to-brain` recipe handles new mail going forward. This guide
covers the one-shot backfill: take Google Takeout, strip the noise, embed
cheaply, sync once.

## The cost problem

A 20-year Gmail archive is typically 300K–700K messages, ~150M tokens of
text. At default settings (`text-embedding-3-large`, no filtering), that is
around $20–35 just for embedding, plus storage and chunking overhead.

60–80% of that volume is noise: promotional mail, receipts, automated
notifications, calendar invites, list traffic. Dropping it before ingest is
the single biggest win, and it improves retrieval quality at the same time
(less noise = sharper search).

## The cost ladder

| Lever | Relative cost | Effort |
|---|---|---|
| Default (`text-embedding-3-large`, no filter) | 1× | none |
| `GBRAIN_EMBEDDING_MODEL=text-embedding-3-small` (6.5× cheaper) | ~0.15× | env var |
| Pre-filter mbox (drops 60–80% of volume) | ~0.3× | one script run |
| Both combined | **~0.05×** | both |

For a 500K-message archive, "both" typically lands under $5 end to end.

## Workflow

### 1. Export

Request a Gmail-only Google Takeout: <https://takeout.google.com>. Select
only Mail, MBX format. Takes 1–24h to assemble; Google emails you a link.

### 2. Filter the noise

```bash
bun scripts/filter-gmail-mbox.ts path/to/All\ mail\ Including\ Spam\ and\ Trash.mbox ./gmail-backfill
```

Default filters drop:

- `noreply@`, `no-reply@`, `notifications@`, `alerts@`, `donotreply@`,
  `mailer-daemon@`, `postmaster@`, `bounces@`
- Anything carrying a `List-Unsubscribe` header (marketing, newsletters)
- `text/calendar` MIME messages (already covered by calendar-to-brain)
- Quoted-reply `>` lines (each message only embeds its new content)

Override with `--keep` for high-signal automated senders:

```bash
bun scripts/filter-gmail-mbox.ts archive.mbox ./out \
  --keep mybank.com,united.com,booking.com
```

Output layout:

```
gmail-backfill/
  2003/
    07/
      welcome-to-gmail-a1b2c3d4.md
  ...
  2026/
    04/
      lunch-tomorrow-f9e8d7c6.md
```

One markdown file per kept message, grouped by sent-month. Each file carries
`type: email` frontmatter plus From / To / Subject / Date / Message-ID.

### 3. Pick your embedding model

For a historical backfill, `text-embedding-3-small` gives ~90% of
`-large`'s retrieval quality at 6.5× lower cost. Set it once before sync:

```bash
export GBRAIN_EMBEDDING_MODEL=text-embedding-3-small
```

**Consistency warning:** your whole brain needs a single embedding space.
If you have an existing brain embedded with `-large`, switching to `-small`
mid-stream breaks search across the mixed corpus. Either commit to `-small`
for the whole brain (re-embed any existing content) or keep `-large`
everywhere (pay the larger bill). Don't mix.

### 4. Sync

```bash
gbrain sync ./gmail-backfill
```

Standard gbrain sync: chunks, embeds, indexes. Use `--resume` if the run
is interrupted; checkpointing is built in.

## What not to do

- **Don't** dump raw mbox into gbrain and expect good retrieval. The noise
  crushes signal, and the embedding bill is 5–10× higher than it needs to
  be.
- **Don't** re-run filter + sync repeatedly to "get more coverage." Filters
  are deterministic; the same mbox always produces the same output. Adjust
  `--keep` and re-run if you want different results.
- **Don't** mix embedding models across one brain (see warning above).
