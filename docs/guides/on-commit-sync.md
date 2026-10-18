# On-commit sync

On a managed brain, `gbrain serve` can sync a source as soon as a commit lands
in its checkout, instead of waiting for the next scheduled sync. It is off by
default; turn it on with:

```bash
gbrain config set sync.on_commit true
```

The serve reads the flag every 30 seconds, so no restart is needed in either
direction. While it is on, the serve polls `git rev-parse HEAD` in the checkout
of every managed source this host owns, every 3 seconds
(`GBRAIN_SERVE_HEAD_POLL_MS`, 1 to 30 s), with a file watch on the git directory
that only brings the next poll forward. When HEAD has stopped moving for 3
seconds (`GBRAIN_SERVE_HEAD_DEBOUNCE_MS`) and differs from what the source last
synced, the serve runs one managed sync (`--no-pull`) as this host's CLI writer.
A sync that is already running, here or in another process, is never doubled:
the commit waits and gets one more sync when that one ends. A sync that stops
resumable is resumed up to three times. Nothing is written into the checkout or
`.git`, and an idle poll costs one git call per checkout. Both `gbrain serve`
and `gbrain serve --http` run the watcher.

For a small page, expect a commit to be searchable in about 5 to 15 seconds: up
to 3 s to notice, the 3 s debounce, then the page write. The write queues an
`embedding` publication effect that the serve runs right after it, so a small
page is embedded about a second later, under the same consent and spend gates as
any managed write; there is no separate inline-embed setting. A sync run with
`--no-embed`, or one whose cost gate deferred embedding, queues no such effect: its
pages stay stale for `embed-backfill` and make no provider call.

Each managed source's freshness over the last 24 hours shows in `gbrain sync
status --source <id>` (the `freshness` block in `--json`) and in `gbrain
status`: p50 and p95 of commit→searchable (from the commit's committer time to
the page write's `completed_at`) and commit→embedded (to the page's last chunk
embedding, counted only while that write is still the page's current revision
and only for an embedding after the write). A first sync and working-tree
entries are not counted, and a run that spans several commits is dated by its
newest. Doctor `managed_sync_latency` warns when p95 commit→searchable is over
`sync.freshness_target_seconds` (default 300) and fails over one hour; it grades
only a brain with `sync.on_commit` on or a target set, and otherwise reports the
numbers. With grading on, it also warns when the synced commits are not in this
host's git checkout, so their latency cannot be measured. `gbrain doctor
--source <id>` grades only that source. A stopped or stalled sync is reported by
doctor `managed_sync_not_moving`, not by this check.

The rest of managed sync (backlogs, holds, the drain) is in
[live sync](live-sync.md).
