### A write killed in the middle no longer holds up its source

**When a gbrain process dies while it holds the write at the head of a source's queue, the next write clears it at once instead of waiting.** A crash or `kill -9` used to leave that write's claim running with nobody renewing it, and every later write to the source waited behind it (`write_pending`) for the rest of its lease: 30 s while the write was preparing, about 6 minutes while it was publishing. On PGLite that wait happened on every such kill.

- On a PGLite brain, the next gbrain process that opens the brain releases every claim written before it started and runs those writes again. The brain admits one process at a time, so their owners have exited. A process that cannot open the brain releases nothing.
- On Postgres, a process killed on the same machine was already released at once; that is unchanged. A process on another machine, in another container or from before a reboot still waits out its lease, because gbrain cannot prove it is gone.
- `gbrain sources writer status` now says so. A claim whose owner has provably exited reads `owner_exited: true`, `resumes_on_its_own: true` and `owner_live: false`, and its `next` is `claim_owner_exited` (nothing to do) instead of `claim_running` ("the owner is still renewing").
- [docs/guides/troubleshooting.md](docs/guides/troubleshooting.md#stuck-write-head) lists how long each case takes and what status prints meanwhile.

### A write receipt says when its Git commit landed

**A receipt read after the write (`gbrain write-request <id>`, `get_write_request`, `list_write_requests`) now reports where Git is.** For a page on an ordinary (not `canonical: git`) checkout, `persistence.git_state` used to stay `queued` forever, even after the background Git effect committed the file, and no commit was named anywhere. It now comes from the Git effect: `committed` with the commit in `persistence.git_commit`, or `superseded`, `skipped`, `failed` or `retrying` with the cause in `persistence.git_reason`, and `queued` only while the effect is queued. Nothing stored is rewritten, so a Git effect from an earlier build, or one whose commit landed but whose push had to be retried, reads `committed` with no commit. Receipts of `canonical: git` sources are unchanged.

Reported by @ethanbeard (#9227).

<!-- behavior-change: stuck_head_released_9227 -->
<!-- behavior-change: receipt_git_state_live_9227 -->
