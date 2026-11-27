**On a Rust brain that serves several people, more of a member's reads now reach the brain owner instead of being refused.**

### Fixed
- On the Rust engine in served mode, a member's call could stop with "a remote caller's write is not sent to the brain owner" even when the call only read data. The served client sends a remote caller's call to the owner only when it is on the owner's list of remote reads, and 18 typed reads were missing from that list. The list now has the identity lookup behind `whois`, the page and fact trust reads, the mention-coverage reads, and four reads that a write runs before it writes (source membership, the re-derive check, the shared skill-pack table check and the journal limit rows). Each of them either applies the caller's own read scope or reads no private data.
- Reads that can show another member's or the owner's private state (credential grants, live members, writer fences, owner-only source settings, worktree bindings, held pages, stored slug spellings) stay off the list, and no write was added to it.

### Known gap
- On the Rust engine in served mode, a member's write (`declarePersistence`, the local writer row, the retrieval counter) is still refused, so the admin counts, credential-grant writes, unbound claim and world-only spelling flows still stop there.
