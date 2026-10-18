# Sync unblock runbook (for an operator agent)

A managed catch-up on a live checkout (`gbrain sync --source <id> --no-pull`,
thousands of pages, other agents committing to the brain repo every few
minutes) finishes unattended. A page that moves under the run is held, not
fatal; a dropped database connection is retried, not fatal; a relaunch resumes
the frozen manifest at its stored cursor instead of re-freezing it. What is
left for an operator is one loop over two commands, and this page is the
decision table behind them.

**Say to your agent:** *"Keep my brain's catch-up moving and tell me only when
a page needs my decision."*

## The loop

```bash
gbrain doctor --only serve_build_drift --json    # first: on a warning, restart serve and workers and stop here
gbrain sync status --source <id> --json          # every N minutes (read-only)
gbrain sync unblock --source <id> --apply --json # when committed_last_10m is 0 and needs_human is false
gbrain sync <next.argv...>                       # the sync unblock (or status) names: the cursor's own options
```

**Say to your agent:** *"Repair the files sync held and get the catch-up
moving again; ask me only about the ones gbrain will not decide by itself."*

0. Check the build. `serve_build_drift` warns when serve or a worker on this
   host runs an older gbrain build than this checkout; restart them with the
   command it prints before anything else, and stop until it reads ok
   ([serve build drift](troubleshooting.md#serve-build-drift)).
1. Read `status`. `state` (`synced` | `resumable` | `blocked`) and `reason`
   say where the source stands; `cursor` is where the run stands
   (`index/total`, the `pinned_target` commit, `last_advance_at`);
   `committed_last_10m` is the signal that data is moving (a live process with
   a flat cursor is not progress). `holds` and `last_error` each carry the
   triple below, plus `category` and `public_category`. `oldest_blocker` and
   `recovery` are bounded live probes that need no cursor; when one times out
   the state is `resumable` / `status_unknown`, never `synced`. A plain status
   skips the heavy reads (the terminal-failure summary, the checkpoint blocker
   list, the live cursor list): their fields keep their types, and
   `terminal_failures_read`, `checkpoint_blockers_read` and `cursors_read` say
   `not_read` with the `--detail` command as `fix`. Never read a `not_read`
   field as "none"; run the fix when the step needs it.
2. If `needs_human` is false and nothing committed in the last ten minutes,
   run `unblock --apply`: it performs the safe action for every hold that has
   one, refuses the rest by name, and prints the sync to run. For a content
   hold (`invalid_fence`; `frontmatter_slug_conflict` once its lane kind
   ships) the safe action is `repair`: unblock runs the content-repair lane
   (`gbrain repair content`, the same kinds the maintenance run uses) on
   exactly those paths as one bounded apply under the `fences.repair` caps,
   each file bound to the bytes the plan read, and reports every path as
   `repaired`, `held`, `needs_human` or `skipped` with the reason code, the
   location-only receipt (mode, tier, classes, commit state) and the next
   step. `--no-llm` keeps the repairs to their free tiers; `--no-repair`
   refuses every repair-class hold instead, as releases before #6377 did.
3. Run that sync. It re-screens the scheduled files, imports each one that now
   passes and holds again what still fails; the rest of the source is never
   blocked. A cursor an older release left blocked on a
   page fault converts in place (same run, no rediscovery).
4. If `needs_human` is true, stop looping and page a person with the slug and
   `human_reason` from `status` (`next.user_message` is written for relay).

`unblock` is idempotent and drops nothing: the only pages it writes are the
hash-bound repairs it prints a receipt for, the only holds it clears are the
ones those repairs import, and refusing is the only way it leaves a file out.
Each refusal names the file, why, and its fix. A hold whose stored repair
state says a person decides (a manual fence reason, a gate rejection, a paid
wait on a setting only the user changes, a recommended page merge) is listed
`needs_human` and never retried until the file changes.

## The triple

Every hold and error has three fields, from one table
(`src/core/persistence/sync-fault-class.ts`):

- `class`: `page` (one entry moved under the sync; the rest of the source is
  fine), `connection` (the database went away for a moment; nothing is recorded
  against the source), `systemic` (the writer, the binding, an approval or
  gbrain itself; a retry alone changes nothing).
- `safe_actions`: what an agent may do on its own, first choice first. `retry`
  reruns the same sync; `retry_when_clean` re-screens a held file once its edit
  is committed; `repair` previews and applies a hash-bound file repair;
  `reconcile` previews two diverged versions; `upgrade` installs a newer gbrain;
  `migrate` applies the pending schema migrations (`gbrain apply-migrations
  --yes`, as the database role that owns the gbrain tables) before the write is
  resubmitted; `none` waits for a person.
- `needs_human`: a person has to choose or act before it clears;
  `human_reason` says what. A page whose safe action failed three times with
  the same code (`attempts`: a re-hold, or a failed `unblock --apply` or
  repair) over at least 24 hours since it was first held is `needs_human`
  whatever its code says, and `human_reason` ends with both numbers. Two holds
  never escalate this way: a `worktree_dirty` file whose uncommitted bytes
  changed in the last 24 hours (someone is still editing it) and a
  `managed_image_sync_unsupported` image (held by design until multimodal
  embedding is on or the image is excluded). Status and unblock re-read a
  `worktree_dirty` file before calling its edit abandoned, so new bytes hand
  it back to the agent. An abandoned edit's fix is `sync unblock --apply`
  behind `next: ask_user`: the person commits or restores the file, then
  unblock finds it clean and schedules it. A repair-class hold is `needs_human` when its stored repair state
  says so: a fence hold the lane marked `manual` (a manual-only reason, a gate
  rejection, a model answer the run does not retry) or `paid` (spend only the
  user raises), and a slug-conflict hold the lane decided a person must settle
  ([`merge_recommended`](write-refusals.md#merge_recommended),
  [`content_repair_needs_human`](write-refusals.md#content_repair_needs_human)).

## Decision table

<!-- sync-fault-table:begin (pinned by test/sync-runbook-table.test.ts) -->
| Code | Class | Safe actions | Needs human | Escalate when |
|---|---|---|---|---|
| `worktree_dirty` | page | retry_when_clean | no | 3 failed attempts over 24 h with no edit in the last 24 h: the uncommitted edit is abandoned |
| `concurrent_write` | page | reconcile | yes | always: the file and the database page diverge |
| `file_drift` | page | reconcile | yes | always: the page changed in the database since its file was last imported |
| `preparation_stalled` | page | retry, upgrade | no | 3 failed attempts over 24 h, or writer status names a step that never finishes |
| `write_interrupted` | page | retry | no | 3 failed attempts over 24 h: gbrain sources writer status --source <source> --json (read-only) names the load on the write owner |
| `invalid_fence` | page | repair | no | the fence repair preview offers no plan (a manual reason) |
| `invalid_frontmatter` | page | repair | no | the repair preview needs an interpretation (--include-ambiguous) |
| `frontmatter_slug_conflict` | page | repair | no | the lane recorded why it could not decide |
| `rename_held` | page | repair | no | the repair preview needs an interpretation |
| `file_too_large` | page | none | yes | always |
| `content_rejected` | page | none | yes | always |
| `parser_regression` | page | upgrade | yes | always: a gbrain bug |
| `managed_image_sync_unsupported` | page | none | no | never: images stay held while multimodal embedding is off |
| `purged_content` | page | none | yes | always: only the owner clears a purge tombstone |
| `write_gate_rejected` | page | none | yes | always: write_gate.external_mode=reject is the user's setting |
| `legacy_slug_conflict` | page | none | yes | always: only a person decides which legacy page the file takes over |
| `origin_conflict` | page | repair | no | the hold carries a reason (the pages differ, ids conflict or none is the page the path names), or the heal is off |
| `origin_conflict_decision` | page | none | yes | always: the pages differ, their ids conflict or none is the page the path names |
| `revision_conflict` | page | retry | no | the same path fails again after a rerun |
| `page_identity_changed` | page | retry | no | the same path fails again after a rerun |
| `pinned_git_worktree_conflict` | page | retry | no | the same path fails again after a rerun |
| `source_changed` | page | retry | no | the same path fails again after a rerun |
| `pending_import` | page | retry | no | the same path refuses again after a sync imported its file |
| `raw_file_changed` | page | retry | no | the same path fails again after a rerun re-freezes it |
| `file_database_drift` | page | reconcile | yes | always: the file and the database page diverge |
| `canonical_file_missing` | page | repair | yes | always: no sync can import a file that is not there |
| `source_binding_changed` | systemic | none | yes | always: the source or its checkout binding moved |
| `unsafe_file_target` | systemic | none | yes | always: the file target resolves outside its source |
| `cancelled` | page | retry | no | the same group is cancelled again after a rerun |
| `knock_on` | page | retry | no | never: superseded; an older gbrain cancelled this page for another page's failure and a plain sync re-freezes it |
| `run_replaced` | page | retry | no | never: another run of the source superseded this one and covers its pages |
| `outside_fence` | systemic | none | yes | always: a request published outside the cursor that admitted it |
| `knock_on_exhausted` | page | retry | no | never: superseded; a plain sync resumes the entry an older gbrain stopped on |
| `sync_incomplete` | page | retry | no | never: an unfinished cursor resumes with the same command |
| `connection_lost` | connection | retry | no | three reruns in a row end connection_lost (the database is unreachable from this host) |
| `database_contention` | connection | retry | no | three reruns in a row stop on it |
| `write_capacity` | connection | retry | no | writer status shows the cap held by requests that never settle |
| `write_capacity_backpressure` | connection | retry | no | reason lifetime_ids (request ids never free, so only the host raise lifts it), or the pause outlasts a day |
| `capacity_paused` | connection | retry | no | reason lifetime_ids (only the host raise resumes it), or the same pause after the raise |
| `sync_drain_lease_held` | connection | retry | no | never: a holder that stops committing ends the run drain_stalled instead |
| `storage_error` | connection | retry | no | the same error after a rerun (then it is not a dropped connection) |
| `graduation_in_progress` | connection | retry | no | gbrain migrate --status --json reports no running move and the fence still refuses |
| `preparation_systemic` | systemic | upgrade, retry | yes | always |
| `drain_stalled` | systemic | none | yes | always |
| `recovery_required` | systemic | none | yes | always |
| `owner_unavailable` | systemic | none | yes | always |
| `writer_coordinator_required` | systemic | none | yes | always |
| `permission_denied` | systemic | none | yes | always |
| `write_quota_exhausted` | systemic | none | yes | always |
| `write_quota_insufficient` | systemic | none | yes | always |
| `plan_stale` | systemic | none | yes | always |
| `slug_root_mode_mismatch` | systemic | none | yes | always: the two modes give different slugs |
| `invalid_params` | systemic | none | yes | always |
| `cursor_incarnation_retired` | systemic | repair | no | the repair preview lists nothing to retire, or the same code returns after the apply |
<!-- sync-fault-table:end -->

A `cancelled` error whose group was released by a lane fault (`lock_timeout`
or `statement_timeout` on a parallel publish lane) also carries that fault as
`last_error.detail`, and the cancelled rows keep it as their `blocked_reason`
(`lane_lock_timeout`, `lane_statement_timeout`) and in the cancel message.
The verdict is the same retry; the detail says the database, not the page,
ended the group.

Each page of a sync has its own fate (#6712): a page that does not commit is
held, retried or stops the run on its own, and the pages admitted after it
still publish and are counted from their own receipts. No page is cancelled
for another page's failure, and two changes of one page (a delete and an
import of one slug, say) are never published in the same group: the later
one waits for the earlier one, and is held behind it (`blocked_on`) when the
earlier one is held. A file that changed after its request was admitted
(`source_changed`) is retried after the manifest's last entry, at most three
times, then held `worktree_dirty`. A transport fault re-freezes the entry in
place; a systemic stop is re-frozen in place by the next plain sync, at most
three times in a row, and once that bound is spent the next plain sync
resets it and tries again.

A `knock_on` or `knock_on_exhausted` error was written by an older gbrain
(a page cancelled only because another page of its sync did not commit, or
the stop that bounded re-freezing them). Both are superseded: the next plain
sync re-freezes the entry under a fresh request; act on `root_cause` if it
fails again. A cursor refusal is classified by its recorded cause:
`run_replaced` (another run of the source took over; nothing to do) or
`outside_fence` (a request was not the entry its cursor held: a person stops
the extra drain and reports it); an older build's `window_dropped` reads as
a knock-on. A checkpoint refused by a receipt at an index the cursor passed
without a commit is re-assessed on every resume and commits without
rediscovering the manifest; one a receipt still blocks is rediscovered by
the next plain sync.

An unknown code is systemic and human: `gbrain errors <code>` explains it
offline, `gbrain doctor --json` says what the brain thinks.

## What each class means on the ground

### Page

One entry of the manifest moved while the run was somewhere else. The run held
it and kept going; the receipt lists the hold (`held`, `held_count`) and
`gbrain sources status <id>` names each file with its fix.

- `worktree_dirty`: uncommitted working-tree bytes that match neither the
  pinned commit nor the page, so sync did not overwrite them. Whoever edits that
  file (an agent writing to the checkout) commits it; `unblock --apply`
  re-screens it once `git status` is clean for it. Bytes committed at HEAD past
  the pinned target are not a conflict: sync imports them as HEAD has them.
- `concurrent_write`: the Git file and the database page both changed (a
  `remember`, an edit through MCP, a restore). Neither was overwritten; a
  person chooses with `gbrain sources reconcile <id> <slug> --preview`, then
  `gbrain sources retry-held <id>` and the sync.
- `preparation_stalled`: the write owner, not the file, stalled;
  `gbrain sources writer status --source <id> --json` names the step.
  `unblock --apply` schedules the re-screen.
- `write_interrupted`: the database ended the file's statements (SQLSTATE
  57014, a statement timeout or cancel) at every attempt, so the file is held
  and the rest of the source syncs. Writer status names the load on the write
  owner; reduce it, then `gbrain sources retry-held <id>` (or
  `unblock --apply`) and the same sync.
- `invalid_fence` and `frontmatter_slug_conflict`: the content-repair lane
  clears them. Managed sync drops a `slug:` line naming no page or file
  (#6865). `unblock --apply` runs it on the held paths now; the maintenance
  run's `fence_repair` and `content_repair` phases run it by themselves;
  `gbrain repair content --source <id>` previews it. A hold the lane will not
  decide is `needs_human` with the paragraph in `human_reason`
  ([held files](repair.md#held-files)).
- The other repair codes (`invalid_frontmatter`, `rename_held`) stay
  consent-gated: unblock refuses them with the frontmatter repair preview to
  run ([held files](write-refusals.md#held-files-and-content-refusals)).
- `revision_conflict`, `page_identity_changed`, `pinned_git_worktree_conflict`
  as a `last_error` come from a run on an older release; this release holds
  them. Rerun the plain sync: the stopped entry converts in place, the
  manifest is not re-frozen. A `revision_conflict` or `cancelled` error with
  `detail: knock_on` needs no flag: the next plain sync re-freezes the entry
  (act on `root_cause` instead).

### Connection

The database went away under the run. The drain reconnects and retries after
5, 15 and 45 seconds; a drop that then moves data is a non-event. Three drops
in a row with no page committed between them stop the drain
`connection_lost`; nothing is recorded against the source, and the same
command resumes at the stored cursor. If it keeps happening, the database or
pooler is the problem (`gbrain doctor --json`), not the sync.

### Systemic

A retry alone changes nothing: the write owner is wedged
(`preparation_systemic`, `drain_stalled`), the source binding changed, a
company-brain approval drifted (`plan_stale`), or the principal may not sync.
Page a person with `human_reason`; the fix is on the brain host.

`slug_root_mode_mismatch` is the one systemic code that is a choice, not a
repair: a source in a subdirectory of its repository pins one
`slug_root_mode`, the run used the other, and the two give different slugs.
Ask the user which mode the source keeps. Restoring the pin to the run's mode
lets the next plain `gbrain sync --no-pull --source <id>` finish (the refused
checkpoint is retried by itself); keeping the new pin takes
`gbrain repair managed-sync-orphans --source <id>` (it lists the cursor as
`slug_mode_refused`; preview, then `--apply --expect <hash>`), after which the
next sync discovers the source again under the kept pin. No sync retries that
checkpoint by itself. The pages the refused run wrote keep their old slugs
beside the new ones. A source rooted at its
repository root never gets this code: both modes give it the same slugs, and
a checkpoint an older release refused there as `revision_conflict` finishes on
the next plain sync.

## Why the manifest is not re-frozen any more

The frozen manifest always lived in the cursor (`op_checkpoints`, op
`managed-sync`). What threw it away was the failure ledger: every run death
wrote a row, and the retry read the row and rediscovered from index 0
(eight to twelve minutes of silence on a 14k-entry source). Page faults are
now holds and connection faults are not recorded, so a relaunch finds
the cursor and resumes it. Only a systemic
failure still writes a ledger row.

When HEAD moved past the pinned target while the run drained, the drain takes
exactly one more pass (an incremental pin..HEAD discovery) so the invocation
ends at HEAD; never a second one, so a live checkout cannot loop.

## A cursor doctor reports that no sync can reach

`sync_incomplete` in the table above resumes with the same command because the
live writer reads its own cursor key. A cursor written under a key nothing
current derives (an older writer identity such as a `legacy_token` principal,
a revoked local writer, a cursor from before sync options were recorded) is
still read by doctor, so `sync_failures` reports it after every green sync.
That is not a page fault and no rerun clears it: preview
`gbrain repair managed-sync-orphans --source <id>`, relay the listed classes
(`no_cursor`, `principal_unadoptable`, `superseded`) and the kept rows, then
apply with the printed `--apply --expect <hash>` once the user agrees. A cursor
with a live pending request is kept; the loop above owns it
([repair guide](repair.md#managed-sync-orphans)).

## Soak counters

`gbrain doctor --json` reports `sync_soak_counters` (info, never a warning):
how often a person or an agent had to step in, per UTC day for the last seven
days, so a soak can show that sync keeps moving on its own.

- `interventions`: `sync_non_plain` (a `gbrain sync` with a recovery flag such
  as the deprecated `--retry-failed`, `--full`, `--break-lock` or `--skip-failed`; the plain
  scheduler flags `--all`, `--no-pull`, `--hard-deadline`, `--no-embed`,
  `--no-lanes`, `--no-bulk` and `--json` do not count), `repair_apply` (a
  `gbrain repair … --apply` of any kind but file-drift), `unblock_apply`,
  `retry_held` (a `gbrain sources retry-held` without `--dry-run`) and
  `needs_human` (a hold that turned `needs_human`, counted once, by the first
  sync that sees it).
- `content_decisions`: `file_drift_apply` (a `gbrain repair file-drift
  --apply`) and `file_drift_hold` (a `file_drift` hold a sync found). These
  are choices about which version of a page wins, not interventions; a
  `keep_db` prefix reconciles with no decision and counts in neither line.

Each line has one count per kind and a `total`; `by_day` lists both line
totals for each day that recorded anything. Fields are only ever added.

## Dry-run convergence classes

`sync --dry-run --json` adds a read-only `convergence` receipt. Class actions:
- `none`: settled.
- `owner`: sync finishes it.
- `repair`: a person decides.

## See also

- [`write-refusals.md`](write-refusals.md#held-files-and-content-refusals): every hold code with its recovery.
- [`troubleshooting.md#catch-up-stuck`](troubleshooting.md#catch-up-stuck): the stall branches (a wedged owner).
- [`live-sync.md`](live-sync.md#catching-up-a-large-backlog-on-managed-postgres): running a large catch-up.
- [`AGENT_OPERATOR_v1.md`](../protocol/AGENT_OPERATOR_v1.md): the `fix.next` / `fix.verify` contract every output here follows.
