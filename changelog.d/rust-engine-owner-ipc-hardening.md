**The experimental Rust engine's owner socket now bounds what a second process can make the owner hold, checks who connects, and hands the brain over cleanly when its owner exits; nothing selects the Rust engine yet, so PGLite and Postgres brains are unchanged.**

### Changed
- The owner of a Rust brain refuses a malformed or oversized frame, and a client that sends one cannot make the owner run a call. It caps its call queue, the bytes of call frames it holds and its open connections, and answers a call over a cap with `owner_busy` (retryable), which runs nothing. A peer that is refused for being over the connection cap and never closes its side is cut off after one second.
- The owner accepts only connections from its own user, and says so with `owner_ipc_peer_refused` when another user, or a peer whose user it cannot read, connects.
- A call that carries a far deadline keeps it. A deadline weeks away no longer ends the call at once.
- A write from a remote caller is refused on the client side and is never sent to the owner, which would have run it with the owner's wider access.
- When the owner exits, the next call from a client takes the brain over, or reaches the process that did. A call that was cancelled, or past its deadline, while that happens ends as cancelled or as a timeout that never ran, and no longer runs in this process. If the takeover cannot open the store, the call that started it fails with the store's own error.
- A call made while `disconnect` runs no longer starts a takeover that holds the brain lock after `disconnect` returned.
- The owner keeps the brain lock until a store open that is still pending settles.
- A page stored in segments no longer breaks a second process that reads it through the owner: its metadata crosses the socket and its body fields refuse with `page_body_segmented`, as they do in the owner, and one such page no longer fails the whole list.
- Errors from the owner keep their type across the socket, so link and revision recovery that checks the error type also works from a second process.
- A call that was already sent to the owner and then is cancelled, passes its deadline or loses its owner ends `owner_unavailable` with reason `outcome_unknown`, since the owner may still commit it. A deadline after the send used to end `timeout`. Its advice names the read that shows whether that write committed, and it is retryable only for a call that only reads. The owner now answers that read only after the earlier call has ended, so a read that finds nothing means the write did not commit; a read that cannot wait that long ends `owner_unavailable` with reason `earlier_call_running` and tells nothing.
- A call cancelled or past its deadline while a takeover still opens the store now ends at once, instead of when the open ends.
- A whole operation whose takeover cannot open the store now fails with the store's own error, which is not retryable, instead of a retryable `owner_unavailable`.
- A takeover that a remote job's call starts no longer gives that job's authority to the new owner, so later local calls such as a managed import are not refused.
- Owner sockets speak protocol version 2. A client and an owner of different versions refuse each other, so restart every gbrain process on a Rust brain after the upgrade.
- An error shown over HTTP now hides a process id written as `owner_pid=` too.

### Added
- Three error codes, `owner_busy`, `owner_ipc_peer_refused` and `owner_ipc_protocol`, in the error guide and the public surface, each with `gbrain doctor --json` as its fix.
