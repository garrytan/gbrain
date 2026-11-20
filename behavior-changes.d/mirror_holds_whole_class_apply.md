---
kind: add
---
gbrain repair file-drift --held --side unknown|database|both --prefer file --whole-class --apply --expect <hash> --yes applies a complete whole-class manifest after the user agrees to its hash: each page is re-read and applied only while its pins still match, on a read-only mirror the file is imported into the page database-only (a page version and a private backup first, the checkout untouched), and a stopped apply prints its resume command first and exits 1. A reconcile approved with keep_file_bytes on a source that is a read-only mirror now imports database-only when the file still matches the approved bytes, instead of refusing source_changed.
