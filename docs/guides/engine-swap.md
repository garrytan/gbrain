# Moving a brain to the Rust engine: the engine swap

The Rust engine is opt-in. An existing brain moves to it by an engine swap, after a shadow has run beside the current
engine long enough to prove it gives the same answers (docs/designs/RUST_ENGINE.md, "Shadow mode and swap"). This
guide covers the read-only plan and the run for a PGLite brain. Failback (`--to pglite`) and swapping a Postgres brain
arrive in a later release.

**Say to your agent:** *"Is my brain ready to move to the Rust engine?"*

**Say to your agent:** *"Show me the engine swap plan and what still blocks it."*

**Say to your agent:** *"Move my brain to the Rust engine with the plan I just read."*

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

The plan also prints:

- **The readiness policy** in force and its hash (below).
- **The capability report.** The capabilities the Rust engine serves, and, for each one your current engine reports
  that Rust does not, the engine members that refuse there.
- **The expected write pause.** An estimate of how long writes are refused during a run: the drain of pending requests
  plus two digest passes over the brain's rows, with the inputs it used. It is printed, never bound into the plan hash.
- **Blockers.** What the Rust engine cannot serve for this brain yet. A run refuses while any is listed:
  folder rules (`folder_rules_unserved`) and remote callers (`remote_access_unserved`).

`READY` is evidence, not permission. A `NOT READY` plan can be read but not run. There is no readiness override.

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

1. **Checkpoint.** A copy of the PGLite data directory, written and verified: it loads into a fresh PGLite with the
   same row count in every table. A later step checks its hash again and never uses a checkpoint that changed.
2. **Fence.** Pending requests are drained, then every table of the old brain gets a database-enforced write fence:
   a write that is not part of this run is refused. The fence stays after the swap; it is the way back.
3. **Verify.** A final reconcile copies anything the shadow missed, the Rust id counters are raised to at least the old
   brain's highest ids (sequence values included), a second reconcile must find nothing left to repair, the fingerprint
   probe must pass, and every copied relation must have the same row count and digest on both engines.
4. **Switch and probe.** The config file is switched to the Rust store, then a fresh `gbrain` process opens the brain
   the normal way and must report the Rust engine at that store. Only then does the run report success. If the probe
   fails, the config is put back at once.

A run that stops (a kill, a full disk, a failed digest, a failed probe) keeps its last state and a diagnostic id;
`--status` shows them and `--resume` continues. Until the switch, the old engine keeps authority.

<a id="resume"></a>
### Resume

`--resume` re-checks what the previous steps left (the checkpoint hash, the fence) and continues from the recorded
state. A checkpoint file the run wrote but never recorded is replaced, never trusted. A second run of the same brain
is refused while one is recorded and not finished.

<a id="policy"></a>
## The readiness policy

Criterion 1's minimum shadow duration is a policy value, not a flag: 14 days by default (D14), or a number of days with
an expiry date, or "not required", as an approved ruling sets it. The plan prints it and its hash; the hash is part of
the plan hash, so a change needs a new plan. An expired value falls back to 14 days. A policy can also carry a dated override for one brain: it names the ruling (words, time, place), the
brain it binds (`brain_ref` in the plan's JSON, a digest of the brain's persistence identity) and an expiry date. The
plan prints it and whether it applies here; for every other brain, and after the expiry, the policy's own duration
stands. Today one override is listed (`c1-dec1-swap`, 5 days until Dec 8 2026), for the maintainer's own brain. Privacy, fingerprints, topology,
platform, capabilities, recovery drills, caught-up following and the final digests are never part of a policy.

<a id="readiness"></a>
## Readiness criteria

The plan reads the shadow status (`gbrain engine shadow status --json`). A missing or malformed field is `missing`,
never a pass. With no shadow running, every criterion is `missing`.

1. At least the policy's minimum shadow duration in the epoch (14 days by default), follower lag p99 under 60 s, three consecutive clean reconcile passes,
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
   (`capability_missing`) has no evidence.
6. Zero `privacy_diverged` events.
7. Zero fingerprint mismatches, a passed fingerprint probe and a passed allocator verification.
8. Speed: paired bench samples. **Reported, not gating.** D23 (the maintainer's C1 ruling of 2026-11-19) makes the
   speed bar gate only turning Rust on by default, not this opt-in swap. The plan shows the numbers and any loss.
9. Zero panics and zero child faults in the shadow.
10. A passed backup and restore drill on the shadow store, and eval gates E1 to E3 in the release.
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
directory for it. Needs the user's decision to start one: `gbrain engine shadow start` (it shows a plan and needs
`--yes --expect <hash>`), then `gbrain engine shadow seed`. Read the plan again after the shadow has run for the
readiness window. There is no override.

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

<a id="folder_rules_unserved"></a>
### `folder_rules_unserved`

The brain has folder rules (`.gbrain/access.yml` in a source, or access rule rows). The Rust engine cannot edit them
yet (`gbrain access rule add`, `rm`, `revert` and `import` refuse on Rust), so a swapped brain could not change who
reads its folders. Not retried until a release serves those edits on Rust.

<a id="remote_access_unserved"></a>
### `remote_access_unserved`

Remote callers use the brain: an active access token, an OAuth client or remote MCP. The Rust engine does not check a
bearer token yet, so every remote caller would be refused after the swap. Not retried until a release serves it. The
refusal gives counts only, never a token name or hash.

<a id="brain_in_use"></a>
### `brain_in_use`

Another process holds the brain: a `gbrain serve`, a shadow-serving process or a running command. The swap holds the
brain for the whole run. Stop that process, then run the swap again.

<a id="verification_incomplete"></a>
### `verification_incomplete`

The run could not prove the engines equal or could not finish a state: the checkpoint did not verify or changed, the
fence could not be put in place, a reconcile failed, the id counters did not pass, or the route probe did not see the
Rust engine. The old engine keeps authority (a failed probe undoes the switch at once), the diagnostics are in the run
record, and `--resume` retries the step, up to three times before you report it.
