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
gbrain sync status --source <id> --json          # every N minutes (read-only)
gbrain sync unblock --source <id> --apply --json # when committed_last_10m is 0 and needs_human is false
gbrain sync <next.argv...>                       # the sync unblock (or status) names: the cursor's own options
```

**Say to your agent:** *"Repair the files sync held and get the catch-up
moving again; ask me only about the ones gbrain will not decide by itself."*

1. Read `status`. `cursor` is where the run stands (`index/total`, the
   `pinned_target` commit, `last_advance_at`); `committed_last_10m` is the
   signal that data is moving (a live process with a flat cursor is not
   progress). `holds` and `last_error` each carry the triple below.
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
   blocked. With `--retry-failed` a cursor an older release left blocked on a
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
  `none` waits for a person.
- `needs_human`: a person has to choose or act before it clears;
  `human_reason` says what. A page held three times with the same code
  (`attempts`) is `needs_human` whatever its code says: it keeps moving under
  the sync. A repair-class hold is `needs_human` when its stored repair state
  says so: a fence hold the lane marked `manual` (a manual-only reason, a gate
  rejection, a model answer the run does not retry) or `paid` (spend only the
  user raises), and a slug-conflict hold the lane decided a person must settle
  ([`merge_recommended`](write-refusals.md#merge_recommended),
  [`content_repair_needs_human`](write-refusals.md#content_repair_needs_human)).

## Decision table

<!-- sync-fault-table:begin (pinned by test/sync-runbook-table.test.ts) -->
| Code | Class | Safe actions | Needs human | Escalate when |
|---|---|---|---|---|
| `worktree_dirty` | page | retry_when_clean | no | held 3 times: the file keeps changing without being committed |
| `concurrent_write` | page | reconcile | yes | always: the file and the database page diverge |
| `preparation_stalled` | page | retry, upgrade | no | held 3 times, or writer status names a step that never finishes |
| `invalid_fence` | page | repair | no | the fence repair preview offers no plan (a manual reason) |
| `invalid_frontmatter` | page | repair | no | the repair preview needs an interpretation (--include-ambiguous) |
| `frontmatter_slug_conflict` | page | repair | no | the repair preview needs an interpretation |
| `rename_held` | page | repair | no | the repair preview needs an interpretation |
| `file_too_large` | page | none | yes | always |
| `content_rejected` | page | none | yes | always |
| `parser_regression` | page | upgrade | yes | always: a gbrain bug |
| `managed_image_sync_unsupported` | page | none | no | never: images stay held by design |
| `revision_conflict` | page | retry | no | the same path fails again after a rerun |
| `page_identity_changed` | page | retry | no | the same path fails again after a rerun |
| `pinned_git_worktree_conflict` | page | retry | no | the same path fails again after a rerun |
| `source_changed` | page | retry | no | the same path fails again after a rerun |
| `sync_incomplete` | page | retry | no | never: an unfinished cursor resumes with the same command |
| `connection_lost` | connection | retry | no | three reruns in a row end connection_lost (the database is unreachable from this host) |
| `database_contention` | connection | retry | no | three reruns in a row stop on it |
| `write_capacity` | connection | retry | no | writer status shows the cap held by requests that never settle |
| `storage_error` | connection | retry | no | the same error after a rerun (then it is not a dropped connection) |
| `preparation_systemic` | systemic | upgrade, retry | yes | always |
| `drain_stalled` | systemic | none | yes | always |
| `recovery_required` | systemic | none | yes | always |
| `owner_unavailable` | systemic | none | yes | always |
| `writer_coordinator_required` | systemic | none | yes | always |
| `permission_denied` | systemic | none | yes | always |
| `plan_stale` | systemic | none | yes | always |
| `invalid_params` | systemic | none | yes | always |
<!-- sync-fault-table:end -->

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
- `invalid_fence` and `frontmatter_slug_conflict`: the content-repair lane
  clears them. `unblock --apply` runs it on the held paths now; the maintenance
  run's `fence_repair` and `content_repair` phases run it by themselves;
  `gbrain repair content --source <id>` previews it. A hold the lane will not
  decide is `needs_human` with the paragraph in `human_reason`
  ([held files](repair.md#held-files)).
- The other repair codes (`invalid_frontmatter`, `rename_held`) stay
  consent-gated: unblock refuses them with the frontmatter repair preview to
  run ([held files](write-refusals.md#held-files-and-content-refusals)).
- `revision_conflict`, `page_identity_changed`, `pinned_git_worktree_conflict`
  as a `last_error` come from a run on an older release; this release holds
  them. Rerun with `--retry-failed`: the stopped entry converts in place, the
  manifest is not re-frozen.

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

## Why the manifest is not re-frozen any more

The frozen manifest always lived in the cursor (`op_checkpoints`, op
`managed-sync`). What threw it away was the failure ledger: every run death
wrote a row, and `--retry-failed` read the row and rediscovered from index 0
(eight to twelve minutes of silence on a 14k-entry source). Page faults are
now holds and connection faults are not recorded, so a relaunch, with or
without `--retry-failed`, finds the cursor and resumes it. Only a systemic
failure still writes a ledger row.

When HEAD moved past the pinned target while the run drained, the drain takes
exactly one more pass (an incremental pin..HEAD discovery) so the invocation
ends at HEAD; never a second one, so a live checkout cannot loop.

## See also

- [`write-refusals.md`](write-refusals.md#held-files-and-content-refusals): every hold code with its recovery.
- [`troubleshooting.md#catch-up-stuck`](troubleshooting.md#catch-up-stuck): the stall branches (a wedged owner).
- [`live-sync.md`](live-sync.md#catching-up-a-large-backlog-on-managed-postgres): running a large catch-up.
- [`AGENT_OPERATOR_v1.md`](../protocol/AGENT_OPERATOR_v1.md): the `fix.next` / `fix.verify` contract every output here follows.
