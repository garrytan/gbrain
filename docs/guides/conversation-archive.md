# Conversation archive

The conversation archive writes one redacted page per conversation per local day, read from your agent harnesses
(Claude Code, Codex, OpenClaw, Hermes, Grok), plus one index page per day. On a **personal** brain it is **on by
default** and the maintenance pass runs it; a **shared** team brain is only offered it and stays off until its owner
turns it on.

```bash
gbrain transcripts archive off                         # turn it off; pages already written stay
gbrain transcripts archive on                          # turn it on (a shared brain, or after off)
gbrain transcripts archive run --dry-run               # preview the last two local days
gbrain transcripts archive run                         # write them
gbrain transcripts archive backfill --from 2026-09-01  # older history, newest days first
gbrain transcripts archive status                      # readers, timezone, archived and held days
gbrain doctor --only transcript_archive_freshness      # is it keeping up?
```

## On by default

`transcripts.archive.enabled` decides. Set to on or off, it always wins. Unset, it is on when the brain is personal
(`brain.audience personal`, or an undeclared brain the audience heuristic reads as personal; see
[ambient writeback](ambient-writeback.md#who-gets-asked-and-who-is-never-asked)) and off on a shared or unknown brain,
which is only offered it. It is always off on a thin client and for a remote caller: the archive reads the harness
sessions of the brain host's own machine. If the setting cannot be read, it counts as off.

`gbrain init` and `gbrain setup <harness>` state the archive in their first-run settings, and an existing personal
brain sees a one-time upgrade notice saying it is on and how to turn it off. Neither waits for an answer.

## What leaves the machine

- On a keyless brain, nothing: pages are written to the local brain and searched by keyword.
- With an embedding key, the archived text of new days is sent to that provider to be embedded, like any new page: unattended upkeep caps that at
  `maintenance.embed_daily_usd`; autopilot and a managed brain's write coordinator embed new pages as they arrive. Older history written by backfill is keyword-only, and its embedding waits
  until you see the price and approve it:

  ```bash
  gbrain embed --held --dry-run     # what it would cost
  gbrain embed --held               # after you agree
  ```

- No facts are extracted and no Dream synthesis runs on archive pages.

## The maintenance pass

The archive runs from the existing maintenance pass: the idle upkeep of an agent's `gbrain serve`,
`gbrain maintain --unattended` (and `gbrain maintain --schedule`), and the autopilot tick (`gbrain autopilot --install`).
Each pass archives the forward window (`archive run`), then one capped `backfill` run of older days, newest first,
until none are left. It runs at most once per `transcripts.archive.maintenance_floor_min` (default 360), one runner at
a time, never when the archive is off, and never fails the pass: its outcome, errors included, is recorded in
`transcripts.archive.last_maintenance` and shown by doctor. One pass is bounded by count (the run window and
`transcripts.archive.backfill_days_per_run` older days) and by time: after 120 seconds it starts no new conversation,
and the next pass picks up the rest.

`gbrain transcripts archive run` archives now, on demand, whatever the pass is doing; it works with automatic
maintenance turned off (`maintenance.auto false`).

On a managed brain the pass writes each day page as a `put_page` write request through the write coordinator, under the
same local identity as `gbrain transcripts archive run` (`local_cli`). Waiting for the coordinator counts against the
120 seconds; a write it accepted but has not published yet counts as archived, publishes on the coordinator's next turn,
and is not written again.

## Search

An archive page ranks a little below a page you wrote that scores close to it (rank prior 0.8), and one result list
holds at most two archive hits for the same day. A question about a conversation or a date ("what did we discuss",
"when did ...", "yesterday", `2026-11-02`) ranks archive pages like any other. `gbrain config set search.rank_priors
false` turns both off.

## Doctor

`gbrain doctor --only transcript_archive_freshness` (brain category) warns when:

- a harness's newest archived day is more than `transcripts.archive.stale_days` (default 2) behind the newest session
  day its reader sees. The fix is `gbrain transcripts archive run`, or
  `gbrain transcripts archive backfill --from <first missing day>` when the gap is wider than one run;
- the archive is on but no maintenance pass has run it in that long. The fix is `gbrain autopilot --install`
  (a persistent service, so it asks first);
- days are held (each is listed with its code, such as `archive_owner_unset` or `archive_redaction_failed`), a reader
  failed, or the last pass recorded an error.

Off is ok with no detail, and a harness with no readable sessions is informational.

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
embedding is held until you approve its cost (`gbrain embed --held --dry-run` shows it, `gbrain embed --held` runs it).

## Old archive folders

If an earlier tool already archived conversations into a folder (a home-made script or cron job), retire it in three
steps. First, `adopt-legacy` lists the days the folder covers so backfill skips them instead of writing a second copy:

```bash
gbrain transcripts archive adopt-legacy --dir ~/brain/conversations            # preview, writes nothing
gbrain transcripts archive adopt-legacy --dir ~/brain/conversations --apply    # record the covered days
```

The old pages are never changed or deleted. Second, remove the old script's schedule yourself (its crontab line or
scheduled job), so two archivers do not run side by side. Third, let the maintenance pass fill the gap, or run
`gbrain transcripts archive backfill --from <day>` now.

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

### When a personal brain becomes shared

Pages archived while the brain was personal name no readers. The first archive run after the brain becomes shared
keeps them to the owner before it writes anything: every folder that holds an archive page at that moment (one per
harness and day, such as `conversations/codex/2026-10-01/`, plus `conversations/days/`) gets an access rule readable
only by the owner. Other pages in the archive source, outside `conversations/`, keep the rules they had. This re-scope **replaces any existing rule on those folders, including one the owner made wider on
purpose**; re-add the wider readers afterwards (`gbrain access rule add`, which waits for `gbrain access apply`) if
you still want them. A rule on the whole `conversations/` folder is left in place, and a page under both rules is read
only by members both allow. Folders written later get no rule, so a group conversation archived on the shared brain
keeps its group, while a group chat added to a day archived before the switch stays the owner's.

The re-scope waits, and `gbrain transcripts archive status` and `gbrain doctor --only transcript_archive_freshness`
each say so in one line, when the shared brain names no owner (`archive_rescope_owner_unset`: run
`gbrain access owner set <member>`) or when the source keeps its access rules in git (`archive_rescope_git_rules`:
add a rule with prefix `conversations/` and the owner as its reader to the source's `.gbrain/access.yml`).

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
