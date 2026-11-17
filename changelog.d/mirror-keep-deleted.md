**Keeping a deletion on a read-only mirror now sticks: the held page stops asking again on every re-check.**

<!-- behavior-change: mirror_keep_deleted -->

### Fixed
- On a read-only mirror, `gbrain repair file-drift --held --side deleted --state tombstone_edited --prefer database` lists each page `keep_deleted` and, once the user agrees to the preview's hash, records the decision on its hold instead of trying to remove a file gbrain never writes. The hold stays, reported carried with reason `mirror_keep_deleted` and `needs_human: false` in `gbrain sources status`, `gbrain sync status` and doctor. A re-check of the same file bytes keeps the decision; a new upstream edit or `gbrain restore` asks again; a purge moves it to the `purged_differs` hold, where it stays while the file bytes are the same. The caller's CLI grant must cover the page, as for every other file-drift repair. Nothing is deleted, restored or written into the mirror, and writable sources behave as before.
