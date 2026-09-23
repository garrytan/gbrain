# Concurrent writes and durable receipts

Each accepted mutation has a durable request UUID scoped to one brain and one
authenticated principal. A response distinguishes acceptance from commitment.
Keep the UUID and original arguments until the request reaches a terminal state.

**Say to your agent:** *"Update this page without overwriting a newer revision;
use `get_page` and `put_page`, then check the durable receipt."* Or: *"Inspect my
writer owners with `gbrain sources writer status --probe --json` before changing
the setup."*

## Read, edit, and retry

Read an existing page with `get_page` and `include_content: true`. Preserve its
complete `content`, `revision`, and source. Send the edited complete content to
`put_page` with `expected_revision` equal to that revision and a newly generated
`request_id` UUID. Capture replacements, delete, restore, and version revert also
accept the revision precondition. `force: true` is an explicit overwrite choice;
it is mutually exclusive with `expected_revision`.

An omitted replacement precondition means create-only. Even byte-identical
input must pass the precondition first: an old reader cannot turn a stale write
into a successful no-op. A canonical content/tag/timeline/deletion/withdrawal
change advances the opaque logical revision. Embeddings, summaries, and other
derived rebuilds do not. Reverting an older version creates a new revision;
it does not reinstate an old revision token. Legacy partial versions preserve
fields that the old version did not record, including whether the page was deleted.
New versions record deletion state: reverting a tombstone version removes the
canonical file and hides the page; reverting a live version restores them.

Facts, takes, and canonical timeline rows commit with their page. The legacy
`auto_timeline` switch does not suppress that required projection; maintenance
may report zero newly reconciled rows because publication already installed them.

`get_page` and `fetch` assemble canonical page fields, tags, withdrawal state,
and the reported revision from one committed database snapshot. While a
publication is in progress, a reader may see the prior committed snapshot.
Separate calls can observe different committed revisions. Search ranking,
embeddings, and direct filesystem reads are outside this snapshot guarantee.

Search reports `projection_pending` while visible canonical revisions still
need a derived-text rebuild, including when other pages already produce hits.
The resident owner rebuilds queued Markdown and code using revision-checked
snapshots. `gbrain reindex-code --force --no-embed` repairs code metadata through
that owner without changing canonical files or revisions. Exact compatible
vectors survive; missing vectors remain explicitly stale, not silently ready.
Rebuilt outgoing code edges are marked for resolution again, while incoming
edges to unchanged target chunks are preserved. These read diagnostics do not
start repairs or authorize provider spending.

Edge resolution uses a transaction and the same ordered page guards as
projection publication. Candidate chunks are revalidated after locking, so a
resolver cannot certify replacement edges from an older read of their IDs.

Do not regenerate a request ID because the response was lost or a waiter timed
out. Repeat the same operation, arguments, source, and UUID. A committed replay
returns its original result; a terminal conflict/failure is not executed again.
Changing the operation or arguments with the same UUID produces
`idempotency_conflict`. Resolve the conflict and use a new UUID for a new intent.
Relative times, generated capture slugs, and trusted owner/resolver defaults
are frozen at admission so retries cannot drift.

## Repair a file/database disagreement

**Say to your agent:** *"Preview the disagreement between this page's file and
database record. Preserve both originals, show me conflicting fields, and don't
apply the repair until I've reviewed it. Then retry my original memory request
separately and verify the fact, visibility, and provenance."*

`source_changed` can mean the file and database disagree even when Git reports a
clean checkout. `sources reconcile` is an exact-page repair, not a force-write
bypass. It works with an already-claimed active owner before or after managed
activation. It never claims, transfers, activates, changes source checkpoints,
or repairs an absent owner. Run it on the canonical host with an existing trusted
CLI write registration. Both its original and current grants must permit
`put_page` for the selected source and exact slug. A CLI can delegate to its
resident PGLite owner; ordinary
HTTP/MCP tokens and stdio credentials cannot administer reconciliation.

Select the brain, source, and exact slug explicitly. Store the preview outside the
canonical repository:

```bash
mkdir -p -m 700 ~/.gbrain/repair
gbrain sources reconcile workspace people/example --brain host \
  --preview --out ~/.gbrain/repair/example.preview.json --json
```

Without `--out`, preview returns a summary only. Preview never changes canonical
content. The private artifact includes both originals and the proposed result;
keep it out of Git, shared directories, and public reports. Output files use mode
0600 and never overwrite existing files. Inspect the artifact locally in a private
editor, or use `jq '.conflicts' ~/.gbrain/repair/example.preview.json`. This output
contains private content; do not paste it into shared logs or public reports.

Fields present on only one side are preserved. Disjoint nested fields combine;
different values require explicit choices. Absence is not a deletion, timestamps
do not decide which side wins, and arrays are whole values. Tags stay add-only.
Provenance, visibility, withdrawals, protected takes, and safety metadata retain
their existing policies rather than accepting merge overrides.

For conflicts, create a decisions file containing a JSON array:

```json
[
  { "path": "/frontmatter/profile/role", "action": "take_file" },
  { "path": "/frontmatter/obsolete_note", "action": "delete" }
]
```

Other actions are `take_database` and `set_value` (with a `value`). Paths use JSON
Pointer escaping: `~0` for `~`, `~1` for `/` inside a field name. Unknown,
duplicate, overlapping, and protected-field decisions are rejected. Render the
final policy-checked result before applying:

```bash
gbrain sources reconcile workspace people/example --brain host --preview \
  --from ~/.gbrain/repair/example.preview.json \
  --decisions ~/.gbrain/repair/decisions.json \
  --out ~/.gbrain/repair/example.resolved.json --json
```

The command prints only a summary. Inspect the actual resolved content locally
with `jq '.result' ~/.gbrain/repair/example.resolved.json` before approving it.

After reviewing a `ready` preview, generate and retain one UUID:

```bash
REQUEST_ID="$(bun -e 'console.log(crypto.randomUUID())')"
gbrain sources reconcile workspace people/example --brain host \
  --apply ~/.gbrain/repair/example.resolved.json \
  --request-id "$REQUEST_ID" --json
```

If the initial preview was already `ready`, apply that artifact instead. GBrain
rechecks the revision, raw bytes, source identity, owner epoch/binding, and safety
policy before publishing. Changed inputs require a fresh preview, not automatic
overwrite. Lost response or pending receipt: retry the same artifact and UUID.
Terminal conflict: make a corrected preview and use a new UUID. Inspect
`get_write_request` until committed; accepted is not the same as saved. That
helper requires its own operation grant. If it is not granted, replay the same
apply artifact and UUID to inspect the original request without widening grants.

Both originals are retained privately in `~/.gbrain/reconciliation-previews/`,
independently of temporary recovery records and receipt compaction. Backups use
bounded local capacity; capacity or disk failures refuse the repair before
publication. Local history does not protect against disk loss, and forgetting an
active fact does not erase historical backups.

Inspect backups for the exact page using `sources reconcile workspace
people/example --brain host --backups --json`. After reviewing retention needs
and copying any history you want to keep to another private location, remove an
exact returned reference with `--remove-backup <reference>`. Removal is explicit
and refuses nonterminal or recovering requests. It never deletes the page or
changes its immutable receipt. Backups from an interrupted pre-admission attempt
remain private and require operator inspection rather than automatic removal.

After commitment, submit the originally blocked `remember`, capture, or other
edit separately with its own new UUID. Read back the fact, visibility, and
provenance. Repair never silently replays a failed memory intent.

For bounded, read-only verification after sync:

```bash
gbrain sources reconcile workspace --brain host --audit --limit 25 --json
```

Continue with `--after` and the returned `next_after`. `complete` means the end of
the source was reached, not that it is drift-free. Results name scoped slugs and
reasons without page content. Whole-source audit requires a CLI grant without a
slug-prefix restriction. `sources writer activate --dry-run` includes a bounded
drift sample and identifies incomplete samples without authorizing repairs.

Atom scan/failure bookkeeping now lives outside canonical note metadata so
processing progress does not create new disagreements. Unsupported managed atom
extraction refuses before calling a model; this does not migrate every legacy
maintenance writer to managed publication.

### Roll back safely

Stop submitting new reconciliation requests first. Keep a compatible upgraded
owner running until all accepted requests are terminal and recovery has drained;
inspect the durable receipts before disabling the new command or reverting the
binary. Never downgrade an active reconciliation queue to a version that does
not understand its intents. Leave the additive processing-state table and private
backups in place. Do not automatically restore an old preimage over later edits,
and do not disable guards or change ownership as part of rollback.

## Receipt states and errors

| State | Meaning |
| --- | --- |
| `queued` | Accepted; waiting for execution. |
| `running` | An owner is preparing or executing it. |
| `recovering` | Publication must be reconciled before work on that root can continue. |
| `committed` | The canonical mutation and its receipt committed. |
| `conflict` | A precondition or identity conflict prevented commitment. |
| `failed` | The request ended without commitment. |
| `cancelled` | Cancelled before publication began. |

Receipts include `request_id`, `state`, and `retry_after_ms`, with optional
revision, outcome, persistence status, and timestamps. Terminal receipts have
`retry_after_ms: null`. Private queued content, credential hashes, and recovery
bytes are never part of the receipt.

`write_pending` means accepted work remains outstanding. `owner_unavailable`
and `writer_lock_unavailable` do not authorize a competing owner or a fresh
request ID. `queue_capacity` refuses additional admission without evicting
existing requests. `revision_required`, `revision_conflict`,
`idempotency_conflict`, and `source_changed` require correcting the caller's
intent or authority. `recovery_required` names unresolved publication state.
Inspect the attached receipt: absence of an acknowledgment is not evidence of
absence of a write.

CLI-generated UUIDs are retained in pending/error output. If transport delivery
is ambiguous, the client reports `submission_status: "unknown"` and the original
UUID, without fabricating a queued receipt or opening another PGLite engine.
Legacy callers that omit a request ID and lose the entire acknowledgment cannot
recover exact replay identity from the content alone.

Local Unix listeners keep their existing socket addresses when they fit the
portable 103-byte limit. Longer addresses use a deterministic private directory
under `/private/tmp` on macOS or `/tmp` on Linux, independent of `HOME` and
`TMPDIR`. Both CLI discovery and resident servers derive it without opening the
database. The directory must belong to the current OS user with mode `0700`;
clients require a socket with mode `0600`. Unsafe entries are refused. Existing
credentials and hook-secret locations are unchanged. A native binding lock
serializes startup and remains held until the listener has actually closed.


Admission retries confirmed database lock/serialization aborts for up to five
seconds using the same UUID. Persistent contention returns a storage error with
that UUID and no fabricated queued receipt. Keep the ID for the next attempt.

## Frozen memory verbs

`remember` and `forget` accept optional `request_id`. Their frozen success enums
and `protocol_version: 1` are unchanged. Accepted pending memory writes use the
existing `unavailable` error with a populated suggestion and additive
`write_request`/`write_error` metadata. A pending response never claims
`status: "inserted"` or `expired: true`.

The seven-verb surface supports recovery by repeating the original verb with
the same UUID; it does not require an unavailable status helper. A committed
`forget` withdraws the source- and visibility-scoped fact from active memory
even when its physical mirror is pending. Imports and rebuilds honor the
withdrawal ledger. History and backups can remain; withdrawal is not a promise
of physical erasure. See [MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md).

Git, embeddings, and physical withdrawal mirrors report their own `effects`
states on receipt reads. Their retries never change the committed canonical
result. Mirror recovery checks the recorded bytes and blocks its worktree if
an unexpected edit needs repair. Other worktrees can continue. Recovery space
is reserved before touching a file; insufficient capacity leaves the withdrawal
effective and its physical mirror queued.

Git work runs only for repositories already opted into durability hardening.
It commits the affected file without invoking legacy hooks, then attempts a
plain push to the configured tracking remote. It never pulls or rebases source
files. An unconfigured remote is reported as a skipped push. Embeddings wait
for an enabled, configured provider and install only if the page revision and
its text projection still match.

Before managed activation, eligible `put_page` and `capture` writes also
record durable facts-extraction intent. `facts_backstop.queued` means that
intent committed with the page; the `facts-backstop` effect becomes
`dispatched` when its durable worker job is accepted. Extraction availability
is checked by that worker. The handoff is idempotent and rechecks the source,
page revision and current writer grant. Confined writers, unchanged pages,
disabled extraction and dream-generated content do not enqueue work.
After activation the legacy extractor reports `writer_coordinator_required`
and skips; it cannot bypass canonical publication. Activation also causes
previously queued extraction jobs to skip. Canonical receipts remain unchanged.

## Receipt access and explicit grant migration

`get_write_request`, `list_write_requests`, and `cancel_write_request` require
write scope and permission for the exact helper in the current operation grant.
They are on the starter/full surfaces; they do not expand the frozen verb
surface or an agent-only tool grant. Read-only callers cannot use them.

Receipts are principal-owned. Another principal's UUID, an unknown UUID, and a
request whose target is no longer accessible return the same `not_found` result.
Listing selects one source and applies current operation/source/slug fences
before pagination. It exposes neither another principal's queue nor private
input. Cancellation rechecks authority under transaction locks; publication
already in progress or committed cannot be undone by cancellation.

An upgrade does **not** widen an existing `allowedOperations` snapshot. A new
profile may include helpers that an older saved profile did not. Regrant them
explicitly only when the caller needs status access; same-verb replay remains
available under the original mutation grant.

For example, suppose the reviewed existing operation list is exactly
`remember,forget`. A trusted administrator can preview this complete replacement
list on the brain host:

```bash
gbrain auth rescope-client client-example \
  --allowed-operations remember,forget,get_write_request,list_write_requests,cancel_write_request \
  --dry-run --json
```

Inspect `before.allowedOperations`, the source/slug/scope restrictions, and
`before.revision`. Preserve every existing operation that should remain granted.
Then apply the reviewed full list with `--if-version` set to that observed grant
revision; for example, if it was `7`:

```bash
gbrain auth rescope-client client-example \
  --allowed-operations remember,forget,get_write_request,list_write_requests,cancel_write_request \
  --if-version 7 --json
```

The operation flag replaces the complete list. It is not an append flag. Omitted
source, slug, delegated-tool, budget, and surface flags preserve their axes.
If the client is pinned to `verbs`, exposing status helpers also requires an
explicitly reviewed starter/full surface within the server ceiling. New OAuth
scopes require a newly issued access token; existing tokens cannot gain scopes
by changing the client row. For resident PGLite, use the owner's authenticated
grant administration UI/API or stop the resident before ordinary
`auth rescope-client`; the local-writer commands below have their own resident
proxy.

Accepted requests retain their original authority snapshot and intersect it
with the current grant before publication and replay. Revocation, source
archive/recreation, or narrower slug/operation/holder permissions cannot be
bypassed with an old receipt or queued request. Regranting receipt helpers does
not rewrite an accepted mutation's authority snapshot.

## Local registrations and canonical ownership

Routine repair, startup and maintenance must not change writer topology in
response to an ownership error. Inspect `gbrain sources writer status --json`
first and obtain the operator's decision. See the
[state-bound administration procedure](../architecture/topologies.md#writer-administration-is-not-routine-repair).

For an approved coordinated upgrade, update and stop older writers on every host first.
Claim each filesystem source on its canonical host, then inspect writer status
and existing locks. Activation is explicit:

```bash
gbrain sources writer status --probe --json
gbrain sources writer activate --confirm-quiesced --dry-run --json
gbrain sources writer activate --confirm-quiesced \
  --admin-intent writer_activate --expected-state <reviewed-admin-state> --json
```

The quiescence flag asserts that older binaries, external editors and maintenance writers
have been quiesced on every host. It does not authorize a topology change alone:
each non-dry-run claim, activation or transfer requires its exact `--admin-intent`
and the `admin_state` fingerprint from reviewed status. Inspect again after each
change; stale state refuses. A TTY or `--yes` is not a substitute, and explicit
noninteractive provisioning uses the same guards. Activation verifies all owner bindings and
native locking, rejects outstanding legacy leases and unfinished publications,
and makes local refusal records durable before enabling managed writes. Even an
expired lease needs explicit inspection and removal; elapsed time does not prove
its writer stopped. A failed activation leaves managed mode disabled. Status
reports `enabled: false` until activation commits. Run an ordinary write and
read its receipt and revision before resuming writers on the upgraded hosts.

CLI and stdio registrations are durable, separate principals. The CLI lane is
trusted local administration; stdio remains an untrusted memory caller.
Revocation survives restart. Losing a credential file or receiving a denied
response does not silently create a replacement principal.

These commands work through a credential-verified private socket when a local
PGLite owner is running:

```bash
gbrain auth local-writer list --json
gbrain auth local-writer register stdio --source-ids default \
  --allowed-operations remember,forget --scopes read,write --dry-run --json
gbrain auth local-writer revoke 11111111-1111-4111-8111-111111111111 --json
gbrain sources writer status --probe --json
gbrain sources writer claim default --path /absolute/canonical/source \
  --admin-intent writer_claim --expected-state <reviewed-admin-state> --json
```

`register --replace` requires the complete intended grant, revokes the prior
registration, and publishes a new private credential only after database
registration is durable. Output never contains the credential. A revoked CLI
cannot replace itself through the resident socket: stop the owner and explicitly
register the replacement locally. Old private files are retained for recovery,
and their revoked credentials no longer authorize work.

PGLite has one process owner. Postgres permits multiple authenticated ingress
processes, but each canonical filesystem root has one designated host owner.
Nested sources in a shared worktree share its coordination lock. A stale
heartbeat is diagnostic information; it never authorizes taking ownership.
Filesystem-dependent work waits for its owner while database reads continue.

To move a root, prepare on its current owner and retain the returned epoch and
manifest digest. Copy the complete canonical worktree to the successor, then
accept there with the exact epoch and digest:

```bash
gbrain sources writer transfer prepare default \
  --admin-intent writer_transfer_prepare --expected-state <reviewed-admin-state> --json
gbrain sources writer status --json
gbrain sources writer transfer accept default --path /absolute/successor/root \
  --expected-epoch 1 --manifest '<prepared-sha256>' \
  --admin-intent writer_transfer_accept --expected-state <reviewed-successor-admin-state> --json
```

Successful preparation places the root in its draining state and records an
exact path/content manifest. Changed
bytes, missing files, a changed epoch, or unresolved recovery refuse acceptance.
After a lost administration acknowledgment, inspect writer status and local
registrations before repeating a command; administration is not automatically
replayed as a page mutation.

Writer status reports resident ingress state, active preparations, owner epochs,
queued request counts/bytes/age, the last committed sequence for each worktree,
and recovery storage including withdrawal mirrors. Capacity entries show the
configured limit, remaining reservation and the exact configuration key to
adjust; usage at or above 80% includes expansion guidance. Blocked requests carry
a concrete next action. Diagnostics contain no request content, credentials or
private checkout paths.

## Source lifecycle

After activation, source add, archive, restore, remove, purge, path rebind and
managed reclone run through the same registered owner. They take the affected
native locks, wait for publication and withdrawal mirrors to settle, then
advance every membership in a shared root. Already accepted requests for its
old topology finish with `source_changed`; their IDs remain permanently reserved.
Removing and recreating a source gives it a new incarnation. Source removal
retains local storage and never deletes old receipt identities.

Lifecycle commands accept `--request-id` for exact replay after a lost
acknowledgment and `--expected-incarnation` to reject a recreated source. These
UUIDs share the CLI principal's page-write ID domain: reuse for a different
operation conflicts. A lifecycle receipt can be `committed`, `recovering`, or
`failed`. Keep its UUID when inspecting or retrying that exact intent. A new
attempt after a terminal failure requires a new explicit UUID. `--dry-run`
changes neither topology nor storage.

A path rebind requires identical canonical content and deletions in a fresh
candidate checkout; exclude GBrain ownership metadata when copying a candidate.
A managed reclone reserves the configured recovery capacity before cloning and
checks the full staged manifest before replacing the directory. If the old
checkout is missing, its last verified manifest must still match the logical
source; a stale remote is never accepted as recovery. Incomplete directory
replacement blocks that root until its recorded recovery finishes. Neither
recovery nor lifecycle administration reverses a committed fact withdrawal.

Physical checkout identity lives in private durable markers in and beside the
root. Copies, replaced directories, and competing homes cannot claim that same
path as separate worktrees. Keep those markers: removing them does not grant
ownership or authorize failover. Old paths retain their refusal records after
rebind or removal.

## Bounded admission and retention

The CLI routes source mutations through the current resident owner before
opening PGLite. These administrative requests require managed activation;
before activation, stop the resident owner to use legacy source commands.
`sources purge` in managed mode requires an explicit archived source ID and
`--confirm-destructive`; use `sources archived` to inspect candidates. The
automatic expiry walker still coordinates each expired source separately.
`--yes` alone does not authorize destructive managed removal. Keep the UUID
from a pending or uncertain administrative result and repeat the same command,
arguments, and `--request-id` after recovery.

Default admission limits are enforced atomically:

| Reservation | Per principal | Per brain |
| --- | ---: | ---: |
| Outstanding requests | 100 | 1,000 |
| Queued intent bytes | 32 MiB | 256 MiB |
| Lifetime request IDs | 100,000 | 1,000,000 |
| Terminal receipt reservation | 128 MiB | 1 GiB |
| Recovery bytes | — | 1 GiB, also 256 MiB per worktree |

Completion space is reserved at admission. Beforeimage/recovery bytes are
reserved before filesystem publication. Reaching a limit refuses additional
work; it does not discard an accepted request to make room. Terminal diagnostic
compaction has a default eligibility threshold of 30 days and preserves replay IDs, digests, terminal
outcomes, and frozen memory-verb result fields. Pending/recovering requests are
not evicted. Lifetime IDs and replay protection are not silently reset.
