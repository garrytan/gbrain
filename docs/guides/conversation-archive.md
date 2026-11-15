# Conversation archive

The conversation archive writes one redacted page per conversation per local day, read from your agent harnesses
(Claude Code, Codex, OpenClaw, Hermes, Grok), plus one index page per day. It is **off** until you turn it on, and
it only runs when you run it: nothing is scheduled yet.

```bash
gbrain transcripts archive on                          # turn it on for this brain
gbrain transcripts archive run --dry-run               # preview the last two local days
gbrain transcripts archive run                         # write them
gbrain transcripts archive backfill --from 2026-09-01  # older history, newest days first
gbrain transcripts archive status                      # readers, timezone, archived and held days
gbrain transcripts archive off                         # stop; pages already written stay
```

Every command takes `--json` and `--source <id>` (the archive source, `conversations` by default).

## What it writes

- `conversations/<harness>/<YYYY-MM-DD>/<label>-<hash8>`: the messages of one conversation that fall on that local
  day, in the same speaker format as `gbrain transcripts ingest`. A long day splits into `-p2`, `-p3` parts.
- `conversations/days/<YYYY-MM-DD>`: an index of every conversation archived for that day.

Frontmatter carries `transcript_archive` (harness, day, timezone, message count, first and last timestamp, whether
the day is complete) beside the usual `transcript_import` block.

Running the archive again on the same input changes nothing. A day still in progress is rewritten in place as it
grows, and closes once its last message is older than `transcripts.archive.quiet_minutes` (default 180).

## Days and timezone

Days are local days in `transcripts.archive.timezone` (an IANA name such as `America/Los_Angeles`; the machine's
zone when unset). The first run pins the zone for the archive source, so a later timezone change never re-slices
days already written. `run` covers today and the previous `transcripts.archive.run_window_days` days (default 2).

## Backfill

`backfill` needs `--from` (and takes `--to`, default today). One run writes at most
`transcripts.archive.backfill_days_per_run` days, newest first; `status` and the run output say how many wait for
the next run, and the next run skips the days already finished. A run reads each session file once to learn its
days, then reads again only the conversations on the days it writes, and writes them in batches, so a folder of
thousands of sessions stays bounded in memory. Backfilled pages are searchable by keyword at once, and their
embedding is held until you approve its cost with `gbrain embed --held`.

## Old archive folders

If an earlier tool already archived conversations into a folder, `adopt-legacy` lists the days it covers so
backfill skips them instead of writing a second copy:

```bash
gbrain transcripts archive adopt-legacy --dir ~/brain/conversations            # preview, writes nothing
gbrain transcripts archive adopt-legacy --dir ~/brain/conversations --apply    # record the covered days
```

The old pages are never changed or deleted.

## Privacy

Every page is redacted before anything is written (the same secret scan and your pattern file as
`gbrain transcripts ingest`). If redaction fails for a conversation, its days are held with
`archive_redaction_failed` and retried on the next run; a day is never written unredacted.

On a personal brain, archive pages carry no `readable_by`. On a shared brain (a non-personal audience, or two or
more enabled members), every page names its readers:

- the owner member always reads it. With no owner named, every day is held with `archive_owner_unset` until you
  run `gbrain access owner set <member>`;
- a group chat whose chat type the harness verified also lists `group:chat-<hash8>`, where the hash is the first
  8 hex characters of sha256 of `<harness>:<conversation key>`, but only when that group already exists. Create
  the group (`gbrain access group add chat-<hash8>`) and add members to it to share that chat's pages with them.

On a shared brain whose archive source is a git checkout, pages go to a database-only `<source>-owner` source so
private conversations never land in the shared repository.

## OpenClaw

Current OpenClaw keeps live sessions in a database owned by its Gateway. gbrain reads them with
`openclaw gateway call` (`sessions.list`, then `chat.history` per session), so the `openclaw` CLI must be on
`PATH`. Point it at a Gateway with `GBRAIN_OPENCLAW_GATEWAY_URL` and pass its token with
`GBRAIN_OPENCLAW_GATEWAY_TOKEN`; gbrain hands both to `openclaw` through its environment (`OPENCLAW_GATEWAY_URL`,
`OPENCLAW_GATEWAY_TOKEN`), never on the command line. Errors map to `archive_gateway_unreachable`,
`archive_gateway_auth` and `archive_gateway_failed`; a failed read leaves the archive ledger unchanged, so the next
run retries. Checked against OpenClaw 2026.10.9 and 2026.11.3, which list sessions and return history the same way.

Session files OpenClaw keeps on disk are read too, even when the Gateway is down: `<id>.jsonl.reset.<stamp>`, the
zstd-compressed `<id>.jsonl.deleted.<stamp>.<hex>.zst` and the legacy compact backup `<id>.jsonl.bak.<stamp>`.
Several files of one session merge into one conversation (`gbrain transcripts ingest` reads only live files). Migration copies (`*.migrated`, `*.migrated.<n>`,
`<id>.jsonl.pre-doctor-*-repair-<stamp>.bak`) and Doctor's recovery copies (`<id>.jsonl.bak-<pid>-<stamp>`) are
skipped: their sessions live in the Gateway's database, which the next run with the Gateway up reads.

Three OpenClaw limits to know:

- `sessions.list` does not list archived sessions, so a session archived before gbrain first read it is only
  found through its file on disk.
- On 2026.10.9 a session created by an operator has no `chatType`, so the archive treats it as unverified and
  keeps it to the owner.
- `sessions.reset` keeps the same session id and the Gateway then returns only the messages after the reset. The
  archive merges the `.jsonl.reset.<stamp>` file of the same session with the Gateway's history, each message once,
  so the earlier messages stay. When neither holds a message the day page already has, the page is kept as it is
  (day status `kept`), so a reset never shrinks or replaces the archive.

## Repo-less brains

A brain with no git repository archives straight into the database; the archive source is created database-only
when it does not exist. On a personal brain whose archive source is a git checkout, the archive writes the files,
commits only those paths with `gbrain git commit-push`, and syncs the checkout.
