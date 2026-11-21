**A misspelled `readable_by` frontmatter key now refuses the write instead of opening the page to every member.**

<!-- behavior-change: readers_key_misspelled_refused -->

### Fixed
- A page whose frontmatter names its readers with `Readable_By`, `readable-by`, `READABLE_BY`, `readable by` or `readableBy` used to save without complaint and then be readable by every member, because page access reads only the exact `readable_by` key. `put_page`, `edit_page` and `capture` now refuse it with `readers_noncanonical` and store nothing; `ingest_capture`, `brainstorm --save` and `sources reconcile` refuse it the same way. Git sync and `gbrain import` hold such a file with the same code, the rest of the source still syncs, and an existing page keeps its last imported version. A page that also carries the exact `readable_by` key is refused too.
- Write the key as `readable_by` (lowercase, with an underscore) on its own frontmatter line, then save, sync or import again. Pages already stored with a misspelled key are not rewritten.
