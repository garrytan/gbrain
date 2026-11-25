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
   (`capability_missing`) has no evidence. **A criterion 5 pass covers page and link writes only.** Shadow mode copies the
   rows a sampled `putPage`, `deletePage`, `addLink`, `addLinksBatch` or `removeLink` touches from your brain, applies the
   same write to a throwaway Rust store built from that copy (never the live shadow store, never your brain), and compares
   the changed pages and links. The throwaway store holds copies of page content, which may be private, so it lives in a
   `scratch/` directory in your gbrain data home beside `shadow/` (mode 0700, on the same disk and owner as your brain, never in a
   shared temp directory), for one comparison only: it is deleted when the comparison ends, however it ends, and a killed
   shadow's leftovers are swept the next time shadow mode starts. The shadow's own evidence files hold no page content. The row counts as `comparable` when they match and `unexplained_difference` when they do not.
   A write that cannot be checked (the copy could not be read or loaded, the write failed on either side, it ran inside a
   transaction, another write landed in between, it touched too many rows, a copied page is soft-deleted, the source holds a withdrawn or purged fact (the primary then serves a redacted body the copy does not have), or the Rust store cannot keep a copied column) is `uncomparable` and never counts. A comparison whose verdict could not be written leaves the evidence unresolved, and status reads unresolved evidence as no evidence until it is written. On a
   Postgres brain, which other processes can write, a data fence catches another writer: every copied row outside the
   write's own footprint must be unchanged afterwards, no link may have appeared that the write did not add, and a `putPage`
   must read back the revision it returned; otherwise the sample is `uncomparable` (`moved`). PGLite skips the fence, because
   its single-writer file lock means no other process can write. Open gaps: another process editing the very rows the write
   changes is not seen, and shows as an unexplained difference (it can fail criterion 5, never pass it); and a link write that
   names no type, or no source, treats a link another process adds between the same two pages with any type or source as its own. Every
   sampled write of any other kind (tags, chunks, timeline, facts, raw SQL and so on) is counted `capability_missing` under
   its family, so `gbrain engine shadow status` and the swap plan name every family still unchecked. With no verdict yet the
   row stays `missing`; below 1,000 comparable writes it fails and says how many it has. The sample share is the write sample
   rate, 0.05 unless `gbrain engine shadow start --write-sample-rate <0..1>` sets another; it is separate from the read
   sample rate. A sampled write outside a transaction waits (at most 2 seconds) for one small read of the rows it touches
   before it runs; if that read is slow, the write goes ahead and the sample is `uncomparable`. `put_page` and import run
   their page write inside a transaction, so those are `uncomparable` today: only link operations outside a transaction
   (`add_link`, `remove_link`, a by-mention extract batch) can make a write `comparable`. Comparing a page write that ran
   inside a transaction is a planned follow-up, not part of this check.
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
