# `gbrain serve` ↔ `gbrain sync` concurrency (PGLite)

**Short version: on a PGLite brain, `gbrain sync` runs even while `gbrain
serve` is live — the sync is delegated to the serve process, which already
owns the single-writer connection.**

## How it works

PGLite is a single-writer embedded Postgres (WASM). A running `gbrain serve`
(stdio MCP) holds an open PGLite connection on the brain's data directory for
its lifetime, guarded by the data-dir lock (`<dataDir>/.gbrain-lock/`), and a
live holder is never displaced (#2348).

When `gbrain sync` finds a live serve holding the lock, it does not fail —
it delegates:

1. The CLI probes the lock file (read-only). A live `serve` holder routes the
   sync over the serve's IPC socket (`<dataDir>/.gbrain-resolve.sock`,
   secret-gated `sync_start` / `sync_status` / `sync_abort` kinds — the same
   typed-narrow-request channel the retrieval reflex uses; raw SQL never
   crosses the wire).
2. The serve process runs `performSync` on the connection it already owns
   (one delegated job at a time) and the CLI polls progress (phases, banked
   file counts) once a second, printing the final result exactly like a
   direct sync.
3. Ctrl-C sends `sync_abort`: the job settles as a typed partial and the
   next `gbrain sync` resumes from the durable checkpoint. A second Ctrl-C
   exits without waiting.
4. Embeds are ALWAYS deferred under delegation (the inline embed cost gate
   lives in the direct-CLI path) — the serve's idle maintenance sweep drains
   pending embeds afterwards, using the serve process's environment/API keys.
   `--no-embed` also suppresses that drain.

MCP traffic and the delegated sync share the serve's one connection, so the
agent stays *available* throughout, with degraded latency during heavy import
phases (long statements block the event loop; the import yields periodically).

## Limits

| Situation | Behavior |
|---|---|
| Unsupported flags (`--repo`, `--all`, `--watch`, `--workers`, `--exclude`, `--src-subpath`, `--json`, `--break-lock`, anything unclassified) | Refuses by name (default-deny — a silently dropped flag would perform the wrong sync). Drop the flag, stop the serve, or pass `--no-delegate`. |
| `serve --http` | No IPC listener — delegation unavailable; sync refuses politely. Stop the HTTP serve to sync. |
| Serve older than this gbrain version | Typed `stale_serve` refusal — restart the serve on the current version. |
| Mounted brains (`--brain`, `GBRAIN_BRAIN_ID`, `.gbrain-mount`) | Never delegate; the normal connect path applies. |
| Opt-outs | `--no-delegate` or `GBRAIN_SYNC_NO_DELEGATE=1` (client), `GBRAIN_SERVE_SYNC_IPC=0` (serve refuses to register the kinds). |
| Deadlines | The client always sends its resolved hard deadline (interactive default 3600s); the serve bounds the job even if the client dies. `--no-hard-deadline` is the only unbounded encoding. |
| Serve shutdown mid-sync | The serve aborts the job and waits a bounded settle (`GBRAIN_SERVE_SYNC_SETTLE_MS`, default 3000) for the checkpoint flush before disconnecting; the next sync resumes. |

Contention with a live **non-serve** holder (another sync, embed, dream) is
unchanged: bounded 1s-poll wait up to the acquire timeout — that coordination
belongs to the `gbrain-sync:*` advisory row lock, which is a DIFFERENT lock
from the PGLite data-dir lock. Confusing the two sends you debugging the
wrong surface. None of this applies to the Postgres engine, which tolerates
concurrent connections.

## If the serve dies mid-sync

Progress is checkpointed — re-run `gbrain sync` to resume. Two notes:

- The dead serve's `gbrain-sync:<source>` row lock is only auto-reclaimed
  once it is ≥60s old (PID-reuse defense). If the re-run reports a dead-PID
  sync lock, `gbrain sync --force-break-lock` clears it immediately.
- The dead serve's PGLite data-dir lock is reaped automatically (dead PID).

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
