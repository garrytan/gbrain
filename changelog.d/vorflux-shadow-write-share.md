**More real writes are now compared on a Postgres brain: a write is no longer called "moved" because of the process's own bookkeeping.**

### Fixed
- In the shadow run (swap criterion 5), saving a page through the API, removing a link and a sync that adds tags were being thrown away as "moved" even when nothing else touched their rows. The process's own record-keeping after a save, and a link removal's own second delete, counted as another writer. A page's own tags, added a moment after the page in the same transaction, rewrote the page's revision and counted too. Now a sample is marked moved when the data check finds that a row it copied changed or that the page changed after its own transaction, or, except for a pinned in-transaction page write, when this process wrote a page or link meanwhile.
- The process's write counter now counts only writes that can change a page or a link. On a brain with the data check (Postgres), an in-transaction page write whose page was pinned just before the commit (its revision and compared fields, read again afterwards) is judged by the data check and the pin, and not also by the counter. Every other write keeps the data check and the counter.

### Known limits
- For an in-transaction page write, same-process writes to copied rows are caught by the fence and the pre-commit pin, not by the counter; every other write keeps the counter. A same-process write to a row the comparator does not copy cannot change the compared result. A concurrent write to the very link or page rows that a link write or a delete changes is outside the fence (an open gap noted in the code) and can show as a difference instead of "moved"; it never shows as a match.
- A PGLite brain still samples no writes, so its compared count is unchanged.
- A real sync's compared share is still capped by samples lost when the command exits and by the 16-sample queue limit; those are separate fixes.
- A sampled in-transaction page write that still has another call running when its transaction ends cannot be pinned, so it is counted not comparable (`in_transaction_busy`), never a match.
- Each sampled in-transaction page write now makes one extra savepoint and one read just before its commit (sampled writes only; the cost per save is measured in the pull request).
