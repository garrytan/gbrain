**Shadow mode now compares page edits and the links added after a page save, the two most common writes it used to skip.**

### Fixed
- Editing an existing page through put_page or sync, and the mention links a put_page adds afterwards, were counted as not comparable, so they never counted toward the Rust swap check. They are now compared. Nothing to do on upgrade.
- A sampled write inside a transaction waits, for at most 2 seconds, for the calls that started before it, and the transaction's commit or rollback waits for every started write, so a sampled write is never sent after its transaction ends. If the wait is ever cut short, the sample is counted uncomparable with a named reason and the write goes through unchanged.
