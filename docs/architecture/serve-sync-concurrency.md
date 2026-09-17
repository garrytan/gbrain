# `gbrain serve` ↔ `gbrain sync` concurrency (PGLite)

**Short version: on a PGLite brain, `gbrain sync` runs even while `gbrain
serve` is live — the sync is delegated to the serve process, which already
owns the single-writer connection.**

## How it works

PGLite is a single-writer embedded Postgres (WASM). A resident owner holds
its datastore's stable external native lock until the connection closes. A
live holder is never displaced, and failed IPC never authorizes a second open.

The CLI resolves the selected brain before opening its datastore and delegates
to an observed resident owner through authenticated persistence IPC:

1. The CLI uses its durable local CLI registration. HTTP and stdio residents
   expose this listener; a hook secret or stdio registration cannot grant CLI
   authority. Selected PGLite mounts use their own datastore and registration.
2. Before managed activation, the owner runs import-only `performSync` on its
   existing connection. After activation, it advances bounded managed-sync
   slices through the durable journal. The client repeats slices while the
   result is `writer_yield` or `writer_pending`.
3. Managed sync retains its immutable discovery manifest and cursor. If the
   client exits or loses an acknowledgment, accepted page requests can finish;
   repeating the same options resumes the remaining cursor.
4. Embeddings are deferred because delegation bypasses the direct CLI's inline
   cost gate. The owner drains them using its configured provider and keys;
   `--no-embed` suppresses that scheduling.

MCP traffic and delegated sync share the owner's datastore. Managed sync yields
between bounded batches, but import work can still affect read latency. See
[canonical writer enforcement](canonical-writers.md) for scheduling, supported
imports and checkpoint rules, and [concurrent writes](../guides/concurrent-writes.md)
for registration, receipts and recovery.

## Limits

| Situation | Behavior |
|---|---|
| Unsupported flags (`--all`, `--watch`, `--workers`, `--break-lock`, anything unclassified) | Refuses by name. Supported options include `--repo`, `--source`, `--exclude`, `--src-subpath`, `--include-hidden`, and `--json`; accepting a flag does not bypass managed-mode restrictions. |
| `serve --http` or stdio MCP | Both expose authenticated persistence IPC for the local CLI registration. |
| Old or unavailable resident IPC | Refuses the connection instead of opening another engine; upgrade/restart the resident or retry the same options after recovery. |
| Mounted brains | Selected PGLite mounts delegate to their own owner. Postgres does not require PGLite IPC, but canonical worktree ownership still applies. |
| Client opt-outs | `--no-delegate` or `GBRAIN_SYNC_NO_DELEGATE=1` disables delegation; it does not permit opening an already-owned PGLite datastore. |
| Deadlines | The client sends its resolved hard deadline (interactive default 3600s); each owner call is bounded. `--no-hard-deadline` requests no sync deadline. |
| Managed imports | Use `--no-pull`. Git pull/rebase, code/image importers and ignored-file walks remain refused; see the canonical writer guide. |
| Serve shutdown mid-sync | The owner aborts the active slice and awaits its work before disconnecting. Accepted page requests and the managed cursor retain their durable state. |

The older shared-secret `sync_start` / `sync_status` / `sync_abort` protocol
remains a compatibility path for unactivated brains. It has a narrower flag
set and refuses managed brains. `GBRAIN_SERVE_SYNC_IPC=0` disables that legacy
protocol; it is not a substitute for revoking a durable CLI registration.

Datastore ownership and the `gbrain-sync:*` source lease are separate. The
native lock prevents a second PGLite owner; source leases coordinate sync work.
Neither lease expiry nor PID metadata authorizes filesystem ownership takeover.

## If the serve dies mid-sync

The kernel releases its native lock when the process dies. A successor must
acquire that lock and reconcile durable requests and recovery state before
publishing. Legacy `.gbrain-lock` metadata remains for compatibility and
diagnostics; deleting it cannot authorize takeover.

Repeat the same `gbrain sync` options to resume the managed cursor. Unexpected
file bytes keep the affected root blocked for repair, while unrelated roots
can continue. Use `gbrain sources writer status --probe --json` to inspect the
owner and recovery state before attempting administrative repair.

## Diagnosing a sync hang

If a sync wedges (no progress, high CPU), re-run with the per-file begin trace
so the stalling file is named:

```bash
GBRAIN_SYNC_TRACE=1 gbrain sync --no-pull --no-embed --yes
```

The last `[sync] begin import: <path>` line with no following completion is the
file being processed when the hang occurred. Under `--workers >1` / `--all`,
the stuck file is in the set of begin-lines without a matching completion.

If you suspect a schema-pack regex is the cause (a pack with a
catastrophic-backtracking `inference.regex`), complete the sync with the pack
disabled and re-run extraction afterward:

```bash
gbrain sync --no-schema-pack --no-pull --no-embed --yes
```

`gbrain schema lint` flags the classic nested-quantifier ReDoS shapes
(`(a+)+`, `(a*)*`, …) in pack regexes as warnings.

The manual diagnosis above has an automated cousin: the progress-aware stall
watchdog. If the import drain makes no forward progress for
`GBRAIN_SYNC_STALL_ABORT_SECONDS` (default 900; keyed on file-import
progress, not the lock heartbeat), the run aborts with
`reason: 'stall_timeout'` and releases the per-source lock so the next
`gbrain sync` resumes from the checkpoint. It fires BETWEEN files — a hang
inside one file's import runs until the wall-clock hard deadline. `0`
disables it. The full sync-resumability knob table lives in CLAUDE.md
("Sync resumability + lock tuning").
