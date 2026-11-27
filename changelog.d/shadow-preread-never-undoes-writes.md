**Shadow mode no longer undoes a save's own writes when one of its background reads fails.**

### Fixed
- While shadow mode follows a Postgres brain, the follower reads the rows a write is about to delete or re-key before the write runs. Inside a transaction it did that read in a savepoint, and rolling that savepoint back after a failed read (a statement timeout, a cancelled query) also undid statements the same save had sent meanwhile, such as the pipelined calls of `put_page` and sync. The save then committed without them, although each call had reported success. Now each transaction has a call lane. The read first waits for a nested transaction that is still running (without holding the others), then for the calls already running, each wait at most 2 seconds, holds later calls until its own write is sent, and only then opens its savepoint. A call ahead that is running a callback, or a call that does not finish in time, makes the read skip, so that write is described with a wider re-read and the save is untouched. The commit or rollback also waits until no read holds the lane, and at most 2 seconds for the calls the transaction started and did not await.
- Calls inside a nested transaction and writes queued by write sampling go through the lane without waiting for themselves or for their own enclosing transaction, and a held call keeps the page scope it was called in.

### Known limits
- Statements a caller sends straight to the transaction's database handle (`tx.sql`, `tx.db`) are not seen by the lane, so a failed follower read can still undo them. A follow-up owns this.
- A write started after an independent nested transaction that is still running can be sent ahead of a delayed write of an earlier call. This is the same on master, so it is not a change; the same follow-up owns it.
- With shadow mode off nothing changes. With it on, a save pays at most one round trip more when a read has to wait for a call ahead of it; the measured cost is in the pull request.
