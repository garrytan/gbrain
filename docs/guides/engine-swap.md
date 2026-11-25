# Moving a brain to the Rust engine: the swap plan

The Rust engine is opt-in. An existing brain moves to it by an engine swap, after a shadow has run beside the current
engine long enough to prove it gives the same answers (docs/designs/RUST_ENGINE.md, "Shadow mode and swap"). This
guide covers the read-only plan, which is what this release ships. The run (`--yes --expect <hash>`), `--resume`,
`--status` and failback (`--to postgres` or `--to pglite`) arrive in a later release.

**Say to your agent:** *"Is my brain ready to move to the Rust engine?"*

**Say to your agent:** *"Show me the engine swap plan and what still blocks it."*

<a id="plan"></a>
## The plan

```bash
gbrain engine swap --to rust --plan          # the plan, read only
gbrain engine swap --to rust --plan --json   # one JSON document on stdout
```

`--dry-run` is an alias of `--plan`. The plan writes nothing and creates nothing. Before it opens anything it
resolves which brain was selected (`--brain`, `GBRAIN_BRAIN_ID` and a `.gbrain-mount` file are all honored). A mounted
brain is refused with `engine_swap_refused` (reason `team_brain`); only your own brain can be previewed. It then needs
a store that already exists: a PGLite store with no `PG_VERSION` file is refused with `no_brain` before any connection,
because connecting would otherwise initialize a new, empty brain. With a store in place, it opens the brain without
migrating it and reads whether the brain uses managed storage. A managed brain is refused with `engine_swap_refused`
(reason `managed_storage`), because the Rust engine never holds managed storage. Otherwise it reads the worktree
refresh journal and the shadow status, and lists. The shadow status is the same document `gbrain engine shadow
status --json` prints for this brain; with no shadow for it, the verdict is `NOT READY` with reason `no_shadow`:

- the verdict, `READY` or `NOT READY`, and the refusal a run would give;
- one row per readiness criterion (below), each `pass`, `fail`, `missing` or, for criterion 8, `reported`;
- the environment variables set on this machine that can select the current engine (`GBRAIN_DATABASE_URL`,
  `DATABASE_URL`, `GBRAIN_HOME`, `GBRAIN_BRAIN_ID`), by name only, never their values;
- the launchd and systemd user service definitions with `gbrain` in their name, and which of those variables each one
  sets, by name only. A definition the plan could not read is marked `unread: "read_failed"` in the JSON plan and
  "unreadable, names unknown" in the text plan; it is not listed as setting none, so read it yourself;
- the free disk space where the brain lives;
- a plan hash that binds the verdict, each criterion's state and the routes, and ignores the time and the free space.

Two plan items wait for the run's machinery, and the plan names them instead of guessing:

- **Capability report.** It compares what this brain uses with what the Rust engine serves, read through the addon
  loader. That wiring lands with the CLI connect PR, so the report comes with the run.
- **Expected write pause.** The pause is the drain plus the final digest, measured under the write fence the run
  builds. The plan has no fence to measure.

`READY` is evidence, not permission. A `NOT READY` plan can be read but not run. There is no readiness override.

<a id="readiness"></a>
## Readiness criteria

The plan reads the shadow status (`gbrain engine shadow status --json`). A missing or malformed field is `missing`,
never a pass. With no shadow running, every criterion is `missing`.

1. At least 14 days of shadowing in the epoch, follower lag p99 under 60 s, three consecutive clean reconcile passes,
   no unseeded gap rows, and a follower that is caught up. "Caught up" needs the follower's current lag, queue depth
   and coverage watermark in the status; a status that leaves any of them out is `missing`, never a pass, and a
   follower with lag, a queue or an invalid watermark fails.
2. Every operation class used meets its minimum of successful read comparisons, at least 10,000 reads in total, with
   no `capability_missing` in the last 7 days.
3. Zero unresolved `rust_error` and zero unexplained `diverged` results in the last 7 days.
4. The search arms agree: trigram exactly; keyword and title exactly under the `ts_rank` ranker (or E1 and E2 at
   least equal to PGLite and Postgres under the default ranker); vector recall@10 at least 0.98 and at least the
   primary's.
5. Zero unexplained differences on at least 1,000 comparable write comparisons. A shadow that cannot compare writes
   (`capability_missing`) has no evidence. **A criterion 5 pass covers page and link writes only.** For a sampled
   `putPage`, `deletePage`, `addLink`, `addLinksBatch` or `removeLink`, shadow mode copies the rows the write touches from
   your brain, applies the same write to a throwaway Rust store built from that copy (never the live shadow store, never
   your brain), and compares the changed pages and links. The throwaway store holds copies of page content, which may be
   private, so it lives in a `scratch/` directory in your gbrain data home beside `shadow/` (mode 0700, owned by the user
   who runs gbrain, never in a shared temp directory), for one comparison only: it is deleted when the comparison ends,
   however it ends, and a killed shadow's leftovers are swept the next time shadow mode starts. The shadow's own evidence
   files hold no page content. The comparison counts as `comparable` when the two read-backs match and `unexplained_difference` when they do not.
   A write that cannot be checked (the copy could not be read or loaded, the write failed on either side, another write landed in between, it touched too many rows, a copied page is soft-deleted, the source holds
   a withdrawn or purged fact (the primary then serves a redacted body the copy does not have), the Rust store cannot keep
   a copied column, or the shadow could not record that a comparison was starting) is `uncomparable` and never counts as
   `comparable`. On a Postgres brain, which other processes can write, a data fence catches another writer: every copied row
   outside the write's own footprint must be unchanged afterwards, no link may have appeared between the copied pages that
   the write did not add (a link counts as the write's own only when its from page, to page, type, source and origin page
   all match what the write named; a link that names no origin matches only a row with no origin), and a `putPage` must
   read back the revision it returned; otherwise the sample is `uncomparable` (`moved`). A PGLite brain samples no
   writes (below), so the fence never runs there. Open gaps: another process editing the very rows the
   write changes is not seen, and would show as an unexplained difference (it can fail criterion 5, never pass it); and a
   link write that names no type, or no source, treats a link another process adds between the same two pages with any
   type or source as its own.

   **PGLite brains record no write comparisons.** A sampled write waits for one read of the rows it touches, and PGLite has a single
   connection, so a read that runs past its 2 seconds cannot be stopped there and would hold the write behind it. A PGLite brain
   therefore samples no write: it takes no pre-read, `write_comparisons` stays `capability_missing` with zero counts, and criterion 5
   stays `missing`. Postgres keeps the sampler, and stops a slow read with a server-side statement timeout of the same length.

   **Only the owner child records.** Shadow mode runs one child per gbrain process, and only the child that owns the Rust store has a
   fixed evidence epoch; a client of another process's store has none. A client child records no write comparison at all: it adds no
   evidence and can never make criterion 5 pass (it drops its sampled writes and replays nothing), and `gbrain engine
   shadow status` and the swap plan say "client shadow children record no write comparisons". The cost is fewer comparable writes,
   so criterion 5 reaches 1,000 later. Because the owner's epoch never changes during its life, an epoch change while a replay is
   running cannot count that replay's result in the new epoch.

   **How the counts are kept.** Counts live in `write-comparisons.json` in the shadow directory, per evidence epoch, and
   change only under one cross-process lock (the same lock code as the epoch manifest, where a lock whose holder died is taken over through a separate takeover file, so two processes never both enter; a takeover file a crash left behind (it blocks the takeover of a dead holder's lock), or a lock file left empty by a crash between creating it and writing it, refuses the lock until it is removed by hand, because neither can be told apart from a live one, and the tally then records nothing further: a sample it cannot record is no evidence, never a pass). Each update adds this child's
   unsaved results to what the file holds at that moment; it never writes back a copy it read earlier, so one child
   cannot erase a difference another saved, and a result whose save failed is kept and added at the next save. Before a
   replay starts, the child writes its process id into the file's in-flight list, and the replay runs only if that write
   succeeded and is flushed to disk (the file, then its directory); if it did not, the sample counts `uncomparable` (`mark_unwritten`) and nothing is replayed. A process id
   leaves the list only through its own result, or when the process is gone: a replay with no recorded result could have
   been a difference, so a dead process's mark counts `unexplained_difference`. The cost is that a hard kill of the shadow
   child during a replay fails criterion 5 for that epoch. While any mark stands, `write_comparisons.state` reads
   `capability_missing` and this criterion is `missing` (no evidence), not a pass; `gbrain engine shadow status` says how
   many replays have no result yet. Once a comparison has a verdict (`comparable` or `unexplained_difference`) and no mark stands, the state is `measured`, and the pass rule is unchanged. The
   sample share is the write sample rate, 0.05 unless `gbrain engine shadow start --write-sample-rate <rate>` (above 0,
   at most 1) sets another; it is separate from the read sample rate. Above about a 0.05 sample rate, bursts of writes only add `queue_full` (uncomparable) samples, because the child replays one write at a time and holds at most 16 in all (the one replaying and those waiting). A sampled write that never reaches a verdict (the pipe refused it, its read-back was still running at disconnect, or it was still queued when the child hit its exit deadline) is counted `uncomparable` as `send_shed`, `readback_abandoned` or `child_exit_deadline`, never dropped and never comparable. The serving process records the first two in a small file beside the tally without taking the tally's lock, so a busy lock can never stall a write; the shadow child adds them to the tally, and until it has, `gbrain engine shadow status` reads them as replays with no verdict, so no evidence; a journal that cannot be read, or that ends in an unfinished line while its writer is alive, reads the same way, and an unfinished line whose writer is gone is counted once as `lost_unreadable`. Every sampled write of another family is counted
   `capability_missing`, by family, never compared, so `gbrain engine shadow status` and the swap plan name the families sampled so far, which stay unchecked. A sampled write outside a transaction waits (at most 2 seconds) for one small read of the rows it
   touches before it runs; if that read is slow, the write goes ahead untouched. `put_page` and the page write of an import (sync included) run inside a
   transaction, and a sampled one can now be compared too: it reads the same rows on the transaction's own connection before it sends the write, in a
   savepoint that is always rolled back, and it is read back and sent only after the transaction commits. A transaction that rolls back drops its samples, and
   one that holds several pages sends one sample per page after the commit. The savepoint is taken only when the page write is the only call running on the
   transaction (the transaction's other calls wait behind the read, so their statements keep their order); when another call has started and not finished, which is how a pipelined
   import sends its writes together, nothing is read and the sample is `uncomparable` (`in_transaction_busy`), because that call's later statements would run inside the savepoint and be rolled back with it.
   Inside a transaction only `put_page` is compared; a link or delete write in one is
   `uncomparable` (`in_transaction`). A page write is also `uncomparable` when: another write to anything the comparison reads came before it in the same transaction
   (`in_transaction_prior_write`; a version row from `createVersion`, a write of another page, and a write to a bookkeeping table do not count); the same page is written twice
   in the transaction (`in_transaction_same_page`); a later write in it changes the page or its links (`in_transaction_later_write`; the chunk, alias, tag and projection writes an
   import makes after the page do not count, and the contextual-retrieval stamp it makes is replayed with the write; a write inside a nested transaction that rolled back is forgotten; a raw write counts as bookkeeping only when every table it writes is `persistence_counters`, `persistence_effects`, `persistence_requests`, `op_checkpoints`, `write_gate_receipts`, `sources`, `timeline_entries`, `takes`, `content_chunks`, `page_projection_jobs` or `config`, and the three page updates a sync or `put_page` makes after the write are matched by their exact text, so a changed statement is an ordinary write); or it carries an option the Rust store does not take (`unknown_option`: only `sourceId`,
   `allowEmptyOverwrite`, `expectedRevision`, `force` and `inline` are carried).
   **Limits, named plainly.** (1) A sync import sends the `contextualRetrieval` option, which is on by default (mode `title`), and the Rust store does not accept it from this path yet, so on a default brain every sync-import page write is counted `uncomparable` (`unknown_option`); only a brain whose `search.contextual_retrieval` is `none` can produce a comparable import sample. (2) A new page whose import adds tags comes out `uncomparable` as `moved`, because the tag write moves the page's revision after the page is written; the same page imported again with its tags unchanged can be comparable. (3) On a Postgres brain, creating a page through `put_page` or a managed sync can be comparable, but an update of an existing page sends its version row in the same wave as the page write, so it is `uncomparable` as `in_transaction_busy`; a managed sync that updates a source whose sync state is recorded (`sources.last_commit`) can also be `uncomparable` as `preimage_not_loaded`, because the Rust store does not keep that column. (4) The warm single-write lane (`consumer.ts`, a reserved connection's own transaction) is not wrapped, so a write that takes it is never sampled: not compared and not counted. This is a known gap. **Chunks, tags, aliases, timeline entries and takes are not compared**, so a criterion 5 pass still covers page and link writes only.
6. Zero `privacy_diverged` events (the field is absent, not zero, while any privacy check of the last 7 days is unsettled, so criterion 6 has no evidence until it settles).
7. Zero fingerprint mismatches, a passed fingerprint probe and a passed allocator verification.
8. Speed: paired bench samples. **Reported, not gating.** D23 (the maintainer's C1 ruling of 2026-11-19) makes the
   speed bar gate only turning Rust on by default, not this opt-in swap. The plan shows the numbers and any loss. The
   numbers come from an engine-bench speed receipt that you load with `gbrain engine shadow bench --import
   <receipt.json>`; they describe a benchmark corpus, not your brain. Until one is imported the row says "not measured
   yet", and when every open row is a gap in the evidence it says "Rust not shown to be no worse (rows not measured)"
   instead of "Rust slower".
9. Zero panics and zero child faults in the shadow.
10. A passed backup and restore drill on the shadow store, and eval gates E1 to E3 in the release. Run both from
    the shadow's host with `gbrain engine shadow drill`: the drill copies the shadow's own store at one moment while
    the shadow keeps following, checks the copy, opens it once, runs a keyword search on it and deletes it (a store
    over 8 GiB needs the separate physical-copy proof); `--evals` downloads the final eval file pinned to the release
    the shadow's evidence started on. `gbrain engine shadow status` and the swap read only what those commands kept
    (they never fetch), so a drill from an earlier evidence epoch, a drill whose scratch copy was not seen deleted or whose pending marker is still there, a
    file for another platform or another build, and a provisional or unfinished eval file all stay NOT READY; the swap
    prints the reason and `status --json` carries it under `drills`. The drill refuses (`addon_mismatch`) when the
    addon it loads is not the one the evidence started on. A copy that has pages passes only after a keyword search ran on it; while the copy's keyword index is complete
    that search must get a hit (`no_probe_term` otherwise). What each half checks and keeps:
    [engine-shadow-drill](engine-shadow-drill.md). **Say to your agent:** *"Run the shadow restore drill and
    fetch the eval gates."*
11. Eligibility: exactly one observed writer host in the last 7 days with no unknown write path (zero observed hosts
    is no evidence, `writer_coverage_unknown`, never "one host"), a personal brain (not a mounted team brain), and a
    shadow host on a preview target.

<a id="refusals"></a>
## Refusals: `engine_swap_refused`

Every refusal leaves the current engine in charge and writes nothing. The `reason` field names the row.

<a id="managed_storage"></a>
### `managed_storage`

The brain uses managed storage (`persistence_brain.enabled` is true). The Rust engine never holds managed storage, so
the cutover could not carry it and would fail after writes are fenced. This is checked before the refresh journal and
before any readiness criterion. Needs the user's decision: keep the brain on its current engine, or turn managed
storage off for it first. There is no override. A persistence state that is missing or malformed refuses with
`storage_error` instead; it never reads as unmanaged.

<a id="refresh_unsettled"></a>
### `refresh_unsettled`

A worktree refresh (`gbrain sources refresh`) is draining, fenced, merged, syncing or `recovery_required`. The Rust
engine does not resume a refresh, so a carried row would fence its sources for good. This is checked before any
readiness criterion. Fix: `gbrain sources refresh <source> --resume` for each listed source (abandoning one with
`--abandon` needs the user), then read the plan again. Retry once per refresh.

<a id="no_shadow"></a>
### `no_shadow`

No shadow runs for this brain, so there is no readiness evidence: `gbrain engine shadow status` has no shadow
directory for it. Needs the user's decision to run one: `gbrain engine shadow seed` first (it copies the brain into
the Rust store and refuses while shadow mode is on), then `gbrain engine shadow start` (it shows a plan and needs
`--yes --expect <hash>`). Read the plan again after the shadow has run for the readiness window. There is no override.

<a id="not_ready"></a>
### `not_ready`

A readiness criterion fails or has no evidence; the plan lists each one. Keep the shadow running and read the plan
again when the report changes. Never retried on a timer, and there is no override.

<a id="multiple_writer_hosts"></a>
### `multiple_writer_hosts`

Writers on more than one machine in the last 7 days (the plan needs exactly one observed writer host). Such a brain stays on Postgres until the Rust server phase
passes the D17 bar (D19). Needs the user's topology decision.

<a id="writer_coverage_unknown"></a>
### `writer_coverage_unknown`

A write path has no writer observation, no writer host was observed at all, or no 7-day observation window exists yet.
Needs every writer on a build that records observations, then 7 days.

<a id="team_brain"></a>
### `team_brain`

A mounted team brain, whether it was selected with `--brain`, `GBRAIN_BRAIN_ID` or a `.gbrain-mount` file, or the
shadow status reports one. The plan checks the selection before it opens anything, and never opens the mount in place
of your own brain. The preview swaps personal brains only. Not retried; ask whether you meant your own brain
(`gbrain --brain host engine swap --to rust --plan`).

<a id="follower_behind"></a>
### `follower_behind`

The shadow follower has lag, a queue, or an invalid coverage watermark. Wait, up to 3 times 60 s apart, reading the
shadow status; then report.

<a id="digest_mismatch"></a>
### `digest_mismatch`

The final relation digests or sequence checks differ. The old engine keeps authority and the diagnostics are kept.
Report them; never retry blindly.

<a id="route_override"></a>
### `route_override`

An environment variable or service definition still selects the current engine. The plan names it, never its value.
Needs the user to remove it.

<a id="host_access_unbound"></a>
### `host_access_unbound`

An observed writer host has no credential for the shadow host. Needs the user to bind one per host.

<a id="host_access_changed"></a>
### `host_access_changed`

A host would read something different through its planned credential. Needs the separate access approval
(`--accept-access-change --expect <hash>`); the swap approval never implies it.

<a id="fingerprint_semantics_differ"></a>
### `fingerprint_semantics_differ`

The fingerprint probe failed: collation or server semantics differ between the engines. Report it; not retried until
the engine or the source host changes.
