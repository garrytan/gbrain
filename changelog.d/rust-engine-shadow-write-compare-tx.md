**Shadow mode can now compare a page write that ran inside a transaction, which is how `put_page` and sync imports write.**

### Changed
- A sampled `put_page` or import page write inside a transaction used to be counted as uncomparable. It is now compared after the transaction commits, with the same checks as a page write outside one. The rows it touches are read on the transaction's own connection before the write, in a savepoint that is rolled back, so the write is never changed. The result is replayed on a throwaway Rust store. A transaction that rolls back is never compared.
- A sample is counted uncomparable, with a named reason, when the transaction made an earlier write to the page, its links, chunks, tags or versions (a version row for the same page is allowed), wrote one page twice, or sent an option the Rust store does not take. It is also uncomparable when the page write is not alone on its transaction (`in_transaction_busy`), because the comparison's savepoint could otherwise roll back another call's statements.
- A pass of the swap's write check still covers page and link writes only. Chunks, tags, aliases, timeline entries and takes are not compared.

### Known limits
- A sync import sends the contextual-retrieval option, which is on by default and which the Rust store does not take from this path yet. On a default brain those samples are counted uncomparable (`unknown_option`).
- A new page whose import adds tags comes out uncomparable as `moved`, because the tag write moves the page's revision.
- On Postgres, an update through `put_page` or a managed sync is usually busy, and the warm single-write lane is not sampled at all.
