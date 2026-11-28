# Moving a brain to the Rust engine: the engine swap

The Rust engine is opt-in. An existing brain moves to it by an engine swap, after a shadow has run beside the current
engine long enough to prove it gives the same answers (docs/designs/RUST_ENGINE.md, "Shadow mode and swap"). This
guide covers the read-only plan, the run for a PGLite or Postgres brain, and failback, the way back to the old engine.

**Say to your agent:** *"Is my brain ready to move to the Rust engine?"*

**Say to your agent:** *"Show me the engine swap plan and what still blocks it."*

**Say to your agent:** *"Move my brain to the Rust engine with the plan I just read."*

**Say to your agent:** *"Move my brain back from the Rust engine to the engine it used before."*

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
migrating it and reads whether the brain uses managed storage. The Rust engine holds managed storage on one host and, since lane LM slice 3, on a multi-user store
(`GBRAIN_RUST_MULTIUSER=1`, where its checkout locks are leases). A managed brain is refused with `engine_swap_refused`
(reason `managed_storage`) only when the build's Rust engine does not serve managed mode. A managed brain gets its
plan with a `managed_known_losses` list (one "known loss" line in the text plan): today a failing Git effect on a Rust
brain, single-host or multi-user, refuses `raw_sql` instead of parking ([RUST_ENGINE.md](../designs/RUST_ENGINE.md)
conflict row 55a); an unmanaged brain's plan does not carry the field. It reads the worktree
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

The plan also prints:

- **The readiness policy** in force and its hash (below).
- **The capability report.** The capabilities the Rust engine serves, and, for each one your current engine reports
  that Rust does not, the engine members that refuse there.
- **The expected write pause.** An estimate of how long writes are refused during a run: the drain of pending requests
  plus two digest passes over the brain's rows, with the inputs it used. A plan accepted for writers on many hosts adds
  up to 60 seconds the run may wait for the brain server after its switch (below). It is printed, never bound into the
  plan hash.
- **Blockers.** What the Rust engine cannot serve for this brain yet. A run refuses while any is listed:
  folder rules (`folder_rules_unserved`) and remote callers (`remote_access_unserved`).

`READY` is evidence, not permission. A `NOT READY` plan can be read but not run. There is no readiness override; the only
dated policy change is criterion 1's shorter shadow minimum below, which the plan prints with its ruling and end.

<a id="run"></a>
## The run

```bash
gbrain engine swap --to rust --yes --expect <hash>   # run the plan with that hash
gbrain engine swap --status [--json]                 # the recorded run, without opening the brain
gbrain engine swap --to rust --resume [--json]       # continue a stopped run from its last state
```

The command never prompts. Without `--yes` it answers `confirmation_required` (exit 3) with the plan hash to approve.
A run checks, before it writes anything: that the plan for the brain as it is now has the hash you approved
(`preview_changed` otherwise), the blockers above, the readiness verdict, the routes, that no other process holds the
brain (`brain_in_use`), and that the Rust engine addon loads. Then it goes through these states, each recorded (0600,
under `.gbrain/engine-swap/`) before the next starts:

1. **Checkpoint.** A PGLite brain: a copy of the data directory, written and verified: it loads into a fresh PGLite
   with the same row count in every table. A Postgres brain: a `pg_dump --format custom` of its database, verified
   when `pg_restore --list` lists data for every table. A later step checks its hash again and never uses a checkpoint
   that changed. See [the checkpoint](#checkpoint).
2. **Fence.** Pending requests are drained, then every table of the old brain gets a database-enforced write fence:
   a write that is not part of this run is refused. The fence stays after the swap; it is the way back.
3. **Verify.** A final reconcile copies anything the shadow missed, the Rust id counters are raised to at least the old
   brain's highest ids (sequence values included), a second reconcile must find nothing left to repair, the fingerprint
   probe must pass, and every copied relation must have the same row count and digest on both engines.
4. **Switch and probe.** The config file is switched to the Rust store, then a fresh `gbrain` process opens the brain
   the normal way and must report the Rust engine at that store. A plan accepted for writers on many hosts also checks
   the brain server (below). Only then does the run report success. If the probe fails, the config is put back at once.

A run that stops (a kill, a full disk, a failed digest, a failed probe) keeps its last state and a diagnostic id;
`--status` shows them and `--resume` continues. Until the switch, the old engine keeps authority.

<a id="checkpoint"></a>
### The checkpoint

The checkpoint is written under the gbrain home (`.gbrain/engine-swap/<brain>/checkpoint-<run>.tar` for PGLite,
`.dump` for Postgres), never in a brain repo. The directory is 0700 and the file 0600. It holds every page, fact and
token of the brain, so gbrain never prints or uploads it; the run record keeps only its path, size and SHA-256.

On a Postgres brain the run needs `pg_dump` and `pg_restore` at the server's major version or newer, and free space
under the gbrain home at least the size of the database (`pg_database_size`, an upper bound for the compressed dump).
Both are checked before anything is written (`checkpoint_unavailable`). The dump is taken before the write fence, so
a write that lands between the dump and the fence is in the fenced database but not in the dump: the fenced database
is the exact way back, and the dump protects against losing that database.

The run never deletes a checkpoint. Keep it until you have accepted the swap and no longer need the way back to the
old engine; then delete the file yourself.

When the config file holds the Postgres `database_url`, the switch moves it into a 0600 file beside the run record
(`previous-route-<run>.json`) and a failed probe or a rollback puts it back. The URL is never in the run record or in
`--status` output.

<a id="resume"></a>
### Resume

`--resume` re-checks what the previous steps left (the checkpoint hash, the fence) and continues from the recorded
state. A checkpoint file the run wrote but never recorded is replaced, never trusted. A second run of the same brain
is refused while one is recorded and not finished.

<a id="fingerprint-rule"></a>
### The fingerprint rule

Facts are deduplicated by a fingerprint of their normalized text (lower case, collapsed whitespace). Before authority
moves, in either direction, the run probes the Postgres or PGLite engine's fingerprint function against the Rust
engine's. The rule is the probe's own:

- If the server's `lower()` or whitespace class differs from the Rust engine on some characters, the run stops only
  when a stored fact holds one of them (`fingerprint_semantics_differ`, with the count of such facts, never their text).
- If no character differs, any mismatch in the probe's test corpus stops the run.

Stock Postgres differs from the Rust engine on dozens of rare characters (for example U+0085, next line, which the
Rust engine treats as whitespace and Postgres does not), on libc and ICU alike, so its probe always reports corpus
mismatches. A brain whose facts hold none of those characters is not affected and swaps. PGLite differs on none.

<a id="failback"></a>
## Failback: back to the old engine

After a swap, the old engine is not kept current; failback copies the Rust store back under a write fence.

```bash
gbrain engine swap --to pglite --plan              # or --to postgres: what is copied back, every loss; read only
gbrain engine swap --to pglite --yes --expect <hash>
gbrain engine swap --to pglite --resume            # finish a failback that stopped after its switch
```

`--to` must name the engine the brain swapped from. Failback needs a succeeded swap whose old primary still records the
run at cutover (`failback_unavailable` otherwise). It reads the Rust engine only through the read calls it serves (the
page, tags, links, timeline, chunks with embeddings, raw data, takes, files of each page, then facts, open loops,
config keys and sources) and compares them with the same calls on the old primary. The Rust store's shadow digests
are not used: writes made after the swap never update them.

The plan shows, before anything is written:

- how many pages changed, were added or were removed on Rust, and the same counts for facts, open loops, config keys
  and sources;
- the two accepted losses with their counts: `page_version_collapse` (a page changed on Rust gets one new version on
  the old primary for all its Rust-side edits) and `new_row_ids` (a page created on Rust gets a new row id; facts,
  takes and files keep theirs);
- the closed list of what failback does not carry: every table of the old primary no Rust read call returns (its
  rows stay as they were at the swap) and every column of a carried table no read call returns;
- the known limits: the shadow digests above; files with no page, which no Rust read call lists; and a fact's fence
  row, event type, dimension and attribution columns, which no read call returns, so a fact added on Rust after the
  swap makes failback refuse by name (`failback_unavailable`) instead of losing them;
- the [fingerprint rule](#fingerprint-rule).

A run checks the plan hash (`preview_changed`), that no other process owns the Rust store or uses the old primary
(`brain_in_use`) and the routes. Then, each step recorded in the swap's run record:

1. **Copy.** Only what differs is written to the old primary, as the swap run, so its write fence lets these writes
   and no others through. The Rust store is never written; it stays as a recovery point.
2. **Verify.** Both engines are read again and must agree on every read call (`failback_mismatch` names the first
   parts that differ), and the reverse fingerprint probe must pass.
3. **Switch.** The config names the old engine again (and its saved Postgres `database_url`). A last read of both
   engines must still agree, or the config goes back to the Rust engine.
4. **Release and probe.** The write fence is dropped and the old primary's graduation row closed in one transaction,
   and a fresh `gbrain` process must open the old engine.

A brain that fails back can swap again later with a new plan.

<a id="collation_order_differs"></a>
### Lists whose order changes: `collation_order_differs`

The Rust engine lists text keys in byte order, as PGLite does. A Postgres brain whose collation is not byte order (libc
`en_US`, or any ICU locale) lists some of them in its own order, so a few lists answer differently after the swap. This
is a named loss, never a refusal. The plan (and `--plan --json`, field `collation`) names each such list in one of
three classes: the same rows in another order, different rows in a capped list, and the sites not traced to their
output; it counts the text sorts that do not change. A C or POSIX Postgres brain and a PGLite brain get no list. When
the shadow's fingerprint probe has not recorded the source collation, the plan says so and lists every site. Repair
previews made before the swap must be run again: a preview's list order, and so its approval hash, can change.

<a id="remote-callers"></a>
### Remote callers after a swap

A brain with remote callers (access tokens, OAuth clients or remote MCP) does not swap yet (`remote_access_unserved`).
Once it can, one named loss stays: a remote read by the brain owner on a Rust brain refuses by name
(`engine_capability_missing`, "the owner lineage read") until the Rust store models the owner's lineage read. Other
remote callers, and the local CLI, read what they read on the old engine. The swap plan lists it under "Named loss for
remote callers".

<a id="policy"></a>
## The readiness policy

Criterion 1's minimum shadow duration is a policy value, not a flag: 14 days by default (D14), or a number of days with
an expiry date, or "not required", as an approved ruling sets it. The plan prints it and its hash; the hash is part of
the plan hash, so a change needs a new plan. An expired value falls back to 14 days. A policy can also carry a dated
override: it names the ruling (words, time, place), the brains it covers (every opt-in brain, or one brain by
`brain_ref`, a digest of the brain's persistence identity) and an expiry date. The plan prints it and whether it applies
here; after the expiry the policy's own duration stands. Today one override is listed (`c1-opt-in-short-shadow`: 5 days
for every opt-in brain until the end of Tue 2026-12-08 PST). Privacy, fingerprints, topology,
platform, capabilities, recovery drills, caught-up following and the final digests are never part of a policy.

<a id="readiness"></a>
## Readiness criteria

The plan reads the shadow status (`gbrain engine shadow status --json`). A missing or malformed field is `missing`,
never a pass. With no shadow running, every criterion is `missing`.

1. At least 14 days of shadowing in the epoch (5 days for every opt-in brain until the end of Tue 2026-12-08 PST: the
   opt-in swap opens Thu 2026-12-03, and the plan names the override and its end; a new Rust build starts a new epoch), follower lag p99 under 60 s, three consecutive clean reconcile passes,
   no unseeded gap rows, and a follower that is caught up. "Caught up" needs the follower's current lag, queue depth
   and coverage watermark in the status; a status that leaves any of them out is `missing`, never a pass, and a
   follower with lag, a queue or an invalid watermark fails.
2. Every operation class used meets its minimum of successful read comparisons, at least 10,000 reads in total, with
   no `capability_missing` in the last 7 days.
3. Zero unresolved `rust_error` and zero unexplained `diverged` results in the last 7 days.
4. The search arms agree: trigram exactly; keyword and title exactly under the `ts_rank` ranker (or E1 and E2 at
   least equal to PGLite and Postgres under the default ranker); vector recall@10 at least 0.98 and at least the
   primary's.
5. Zero unexplained differences on at least the brain's own write bar of compared writes:
   `min(1000, max(100, window x W))`. The window is criterion 1's shadow minimum in force (5 days while the opt-in
   override applies, until the end of Tue 2026-12-08 PST; 14 days after). W is the brain's qualifying writes a day
   (`putPage`, `deletePage`, `addLink`, `addLinksBatch`, `removeLink`), from the shadow's own call counts with
   sampled-out calls included, over the window (a shorter call history is scaled to a per-day rate). The plan names
   the bar, the window, how W was computed and the compared count. Below the floor of 100 the check stays closed. A
   shadow that cannot compare writes (`capability_missing`) has no evidence. A brain that can opt in (one without
   managed storage) shadows with every write compared (rate 1.0), so on
   Postgres the bar is reachable in 5 days when its writes can be compared; each save is about 2x slower while that
   shadow runs. When start cannot read the storage mode, it also compares every write and says so in the plan; if that
   brain does use managed storage, each save is about 2x slower until `gbrain engine shadow start` runs again and reads
   the mode. On a brain read as unmanaged, `gbrain engine shadow start --write-sample-rate` below 1 is refused, so a
   shadow that makes saves too slow can only be stopped, not thinned. A shadow state there that samples writes (an older
   state, or one edited by hand) fails this criterion with "the shadow compared a sample of writes; restart it so it
   compares every write". A PGLite brain samples no writes (below), so it cannot pass criterion 5 yet. A brain with fewer than 20 qualifying writes a day cannot reach the floor
   in a 5-day shadow.
   When the compared writes fall short of the bar, the plan says why: `write_bar_not_reached` with the share of the
   epoch's qualifying writes that were compared, the writes that cannot be (in a transaction, `uncomparable`,
   `capability_missing`), and after how many days of shadow the bar is reached at that share; or
   `write_bar_unreachable` when none was compared. The bar is never lowered and an uncompared write never counts.
   **A criterion 5 pass covers the pilot page and link writes only.** For a sampled
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
   sample share is the write sample rate: 1.0 on a brain that can opt in (a lower `--write-sample-rate` is refused
   there) or whose storage mode could not be read; on a managed brain 0.05; the flag sets another on those two, as `gbrain engine shadow start --write-sample-rate <rate>` (above 0, at most 1)
   does; the shadow plan prints the rate it applies and its hash binds it; it is separate from the read sample rate. Above about a 0.05 sample rate, bursts of writes only add `queue_full` (uncomparable) samples, because the child replays one write at a time and holds at most 16 in all (the one replaying and those waiting). A sampled write that never reaches a verdict (the pipe refused it, its read-back was still running at disconnect, or it was still queued when the child hit its exit deadline) is counted `uncomparable` as `send_shed`, `readback_abandoned` or `child_exit_deadline`, never dropped and never comparable. The serving process records the first two in a small file beside the tally without taking the tally's lock, so a busy lock can never stall a write; the shadow child adds them to the tally, and until it has, `gbrain engine shadow status` reads them as replays with no verdict, so no evidence; a journal that cannot be read, or that ends in an unfinished line while its writer is alive, reads the same way, and an unfinished line whose writer is gone is counted once as `lost_unreadable`. Every sampled write of another family is counted
   `capability_missing`, by family, never compared, so `gbrain engine shadow status` and the swap plan name the families sampled so far, which stay unchecked. A sampled write outside a transaction waits (at most 2 seconds) for one small read of the rows it
   touches before it runs; if that read is slow, the write goes ahead untouched. `put_page` and the page write of an import (sync included) run inside a
   transaction, and a sampled one can now be compared too: it reads the same rows on the transaction's own connection before it sends the write, in a
   savepoint that is always rolled back, and it is read back and sent only after the transaction commits. A transaction that rolls back drops its samples, and
   one that holds several pages sends one sample per page after the commit. The savepoint is taken only when the page write is the only call running on the
   transaction (the transaction's other calls wait behind the read, so their statements keep their order); when another call has started and not finished, which is how a pipelined
   import sends its writes together, nothing is read and the sample is `uncomparable` (`in_transaction_busy`), because that call's later statements would run inside the savepoint and be rolled back with it.
   Inside a transaction only `put_page` is compared, and only in the outermost transaction; a link or delete write in one, or a `put_page` inside a nested transaction (a savepoint), is
   `uncomparable` (`in_transaction`). A page write is also `uncomparable` when: another write to anything the comparison reads came before it in the same transaction
   (`in_transaction_prior_write`; a version row from `createVersion`, a `putPage` of another page, and a write to a bookkeeping table do not count); the same page is written twice
   in the transaction (`in_transaction_same_page`); a later write in it changes the page or its links (`in_transaction_later_write`; the chunk, alias, tag and projection writes an
   import makes after the page do not count, and the contextual-retrieval stamp it makes is replayed with the write; a write inside a nested transaction that rolled back is forgotten; a raw write counts as bookkeeping only when every table it writes is `persistence_counters`, `persistence_effects`, `persistence_requests`, `op_checkpoints`, `write_gate_receipts`, `sources`, `timeline_entries`, `takes`, `content_chunks`, `page_projection_jobs` or `config`, except that one `LOCK TABLE` statement standing alone is bookkeeping whatever table it names (it changes no row), while a batch that holds a lock among other statements is checked whole by the table rule; and the three page updates a sync or `put_page` makes after the write are matched by their exact text, so a changed statement is an ordinary write); or it carries an option the Rust store does not take (`unknown_option`: only `sourceId`,
   `allowEmptyOverwrite`, `expectedRevision`, `force`, `inline` and `contextualRetrieval` are carried).
   **Limits, named plainly.** (1) An import page write (the one a sync makes, and the one `put_page` makes, which write through the same import) sends the `contextualRetrieval` option unless the page's resolved mode is `none`. The Rust store takes the option and stores the same stamp as the primary, so a default-mode sync import or `put_page` page write is compared like any other, and counts toward this criterion. (2) A new page whose import adds tags comes out `uncomparable` as `moved`, because the tag write moves the page's revision after the page is written; the same page imported again with its tags unchanged can be comparable. (3) On a Postgres brain, creating a page through `put_page` or a managed sync can be comparable, but an update of an existing page sends its version row in the same wave as the page write, so it is `uncomparable` as `in_transaction_busy`; a managed sync that updates a source whose sync state is recorded (`sources.last_commit`) can also be `uncomparable` as `preimage_not_loaded`, because the Rust store does not keep that column. (4) The warm single-write lane (a reserved connection's own transaction, which the persistence consumer lends to single writes) is sampled like any other transaction: the preimage is read after its first statement, so a first statement sent ahead of BEGIN's answer stays first, and the same fail-closed reasons apply. Reads, follow and writer evidence for that lane are unchanged. **Chunks, tags, aliases, timeline entries and takes are not compared**, so a criterion 5 pass still covers the pilot page and link writes only.
   Criterion 5 covers the pilot page and link writes (putPage, deletePage, addLink, addLinksBatch, removeLink) only (#10350, #10360, #10382, #10390). These write types are not compared and get named lines in the swap report: chunks, tags, aliases, timeline entries, takes, facts, fact withdrawals, open loops, sources, owner-only marks and the decide store.

   The swap report prints one line under criterion 5 for each of those types: `chunks: sampled 3 (content_chunks 3)`, or `chunks: not sampled` when the shadow sampled none. A type reads the `capability_missing_by_family` keys named for it: chunks `content_chunks`; tags `tags`; aliases `page_aliases`; timeline entries `timeline_entries`; takes `takes`; facts `facts`; open loops `open_loops`; sources `sources`; owner-only marks `owner_only_marks`; the decide store the eight keys `decide_state`, `decide_spend`, `decision_receipts`, `decide_calibrations`, `decide_proposals`, `decide_review_proposals`, `decide_review_queue` and `decide_sweep_deferred`, summed, with the count of each key that was sampled in parentheses. Fact withdrawals has no key of its own, so its line reads `fact withdrawals: not sampled separately (counted under pages:updateSlug <n>)`. One more line, `other write families sampled: <key n, ...>`, lists every other sampled key (or `none`), so no sampled count is hidden. In `--json` the same lines are `lines` on the criterion 5 row; `detail` and every other field are unchanged. The tally keeps at most 64 keys and files the rest under `other`, so a very wide mix of writes can move a named type's count onto that key.

   The last line is criterion 5's named loss, and it reads the same here. Named loss: only putPage, deletePage, addLink, addLinksBatch and removeLink are compared, so these other page and link writes are counted capability_missing and are not compared: pages:deletePages, pages:softDeletePage, pages:softDeletePages, pages:restorePage, pages:purgeDeletedPages, pages:updateSlug, pages:refreshPageBody, pages:refreshPageOrigin, pages:updatePageContextualRetrievalState, pages:stripStaleFrontmatterKeys, pages:markPagesExtractedBatch, pages:markPagesAttendanceBlocked, pages:setPageEmbeddingSignature, pages:setChunkerVersion, pages:writeTextProjectionSeal, pages:revertToVersion, pages:setEmotionalWeightBatch, pages:invalidateWithdrawnPages, pages:createSegmentedPageShell, pages:sealSegmentedPage, pages:flipBodyGeneration, links:removeLinksByPagesAndSource, links:replaceDerivedLinks, links:replaceDerivedLinksBatch. A write that touches several tables is counted under its first table only, so the side effects of deletePages, purgeDeletedPages and updateSlug (aliases, open loops, owner-only marks, fact withdrawals) land under pages:* keys, and a type's line above reads only the writes whose first table it is.
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

The brain uses managed storage (`persistence_brain.enabled` is true) and the Rust destination cannot hold it: the build's
Rust engine does not serve managed mode (a multi-user store serves it since slice 3, so multi-user mode alone no longer
refuses). The cutover could not carry it and would fail after writes are fenced. This is checked before the
refresh journal and before any readiness criterion. Needs the user's decision: keep the brain on its current engine,
or turn managed storage off for it first. There is no override. A persistence state that is missing or malformed refuses with
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

This row stops refusing only with `GBRAIN_RUST_MULTIUSER=1` and a destination that is a served multi-user Rust brain (the multi-user Rust build, default off); every other criterion still applies.

The plan reads that destination from this host's configuration only, because no server can serve the brain before the
swap. The host that swaps becomes the brain server, so its configuration counts only when all of these hold:

- `GBRAIN_RUST_MULTIUSER=1`.
- `GBRAIN_RUST_SERVER_LISTEN` is the `host:port` you serve on. A server started with only the `--rust-listen` flag does
  not count, because the plan cannot see that flag: set `GBRAIN_RUST_SERVER_LISTEN` to the address you serve on.
- The address is not a loopback address, and `GBRAIN_RUST_SERVER_TLS_CERT` and `GBRAIN_RUST_SERVER_TLS_KEY` are set
  (the plan checks the names only). The other writer hosts must reach the server.
- This host names no server of its own: no `rust_server.url` in its config and no `GBRAIN_RUST_SERVER_URL`. Those make a
  Rust engine on this host a client of that server, so it cannot serve the swapped brain. Set them on the other hosts only.
- The Rust store the swap moves to already exists. Shadow mode creates it the first time it runs for this brain; the plan
  reads the store's brain id from its `FORMAT` file and never opens or creates the store. With no store yet, run shadow
  mode for this brain until it has created its store, then read the plan again.

The row's detail says "accepted on config only" or "not accepted (config only)" with the reason, and the plan hash binds
the listen address and the store's brain id. The swap run checks the live server at that address after its switch and
its route probe: the server must answer over verified TLS (the certificate in `GBRAIN_RUST_SERVER_TLS_CERT` is trusted),
accept the run's probe token, run its brain in multi-user mode and serve the store's brain id. No owner server token can
exist in the new store before the switch, so the run makes its own: the switch writes one short-lived probe token into
the Rust store after the final check; it is removed before the run ends. The token is named `engine-swap-probe-<run id>`,
expires within minutes, is never printed or written to the run record, and failback never carries it (or the store's
owner token lists) back to the old engine. If the run cannot remove it, it prints the `gbrain auth revoke` command to
run. If the server's certificate is signed by a private CA, the file in `GBRAIN_RUST_SERVER_TLS_CERT` must also hold that
CA certificate, or the check fails `tls_failed`; an unreadable file fails the same way before any connection. The run
does not start the server: it prints "engine swap: waiting for the brain server at <url>" once and waits up to 60 seconds
for a server that does not answer yet; any other answer is final. The old primary stays fenced during the wait, so
writes stay refused for up to 60 seconds longer (the plan's write pause includes them). A server that needs longer than
that to open its store makes the run give authority back to Postgres; start it, then run `--resume`. When the check
fails, the run names the reason (`unreachable`, `tls_failed`, `not_served`, `refused`, `not_multi_writer` or
`wrong_brain`); `--status` shows it and `--resume` runs the check again.

**Say to your agent:** *"Check whether my brain, written from two machines, can move to the Rust server."*

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

The fingerprint probe found a stored fact whose fingerprint would differ between the engines, or, on a server whose
characters all agree, a probe mismatch (see [the fingerprint rule](#fingerprint-rule)). Stock Postgres reports corpus
mismatches on rare characters; that alone does not refuse. Report it; not retried until the facts, the engine or the
source host change.

<a id="folder_rules_unserved"></a>
### `folder_rules_unserved`

The brain has folder rules (`.gbrain/access.yml` in a source, or access rule rows). The Rust engine cannot edit them
yet (`gbrain access rule add`, `rm`, `revert` and `import` refuse on Rust), so a swapped brain could not change who
reads its folders. It lifts by itself in a build whose Rust engine reports the `access_control` capability (every
access-control member served, rule edits included); `gbrain engine swap --to rust --plan` then lists no folder-rule blocker.

<a id="remote_access_unserved"></a>
### `remote_access_unserved`

Remote callers use the brain: an active access token, an OAuth client or remote MCP. The Rust engine does not check a
bearer token yet, so every remote caller would be refused after the swap. Not retried until a release serves it. The
refusal gives counts only, never a token name or hash.

<a id="brain_in_use"></a>
### `brain_in_use`

Another process holds the brain: a `gbrain serve`, a shadow-serving process or a running command. The swap holds the
brain for the whole run. Stop that process, then run the swap again. On a Postgres brain, any other gbrain session
connected to the database counts (by its `application_name`), on any machine: stop `gbrain serve`, workers and
autopilot first, because the write fence would refuse their writes.

<a id="checkpoint_unavailable"></a>
### `checkpoint_unavailable`

A Postgres brain's recovery checkpoint cannot be taken: `pg_dump` is not installed, it is older than the server, or the
disk under the gbrain home has less free space than the database. The message names the version or the space needed.
Nothing was written. Install the PostgreSQL client tools at the server's version or newer, or free the space, then run
the swap again.

<a id="failback_unavailable"></a>
### `failback_unavailable`

There is no finished swap to undo: no run record, a run that never switched, a config that does not name the Rust
engine, or an old primary that does not record the run at cutover. It also refuses when a read call cannot return
every row (a source removed on Rust, or 1000 or more open loops of one status in a source), when a page that changed
keeps its body in segments, or when a fact was added on Rust after the swap (its fence row, event type, dimension
and attribution columns have no read call). Nothing was written. Read
`gbrain engine swap --status` and report what it shows.

<a id="failback_mismatch"></a>
### `failback_mismatch`

After the copy, a read call answered differently on the old primary than on the Rust engine. The Rust engine keeps
authority and the old primary stays fenced with the partial copy, which no client reads. A write that reached the Rust
engine during failback is the usual cause: stop every writer and run the failback plan again once; report a second
mismatch.

<a id="verification_incomplete"></a>
### `verification_incomplete`

The run could not prove the engines equal or could not finish a state: the checkpoint did not verify or changed, the
fence could not be put in place, a reconcile failed, the id counters did not pass, or the route probe did not see the
Rust engine. The old engine keeps authority (a failed probe undoes the switch at once), the diagnostics are in the run
record, and `--resume` retries the step, up to three times before you report it.
