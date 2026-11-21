---
kind: fix
---
On a Postgres brain whose database uses a non-C collation, gbrain access serves (open_pages.sources in its JSON output and receipt) and doctor open_shared_pages now list source ids in byte order, the same order PGLite gives. Before, the order followed the database locale, so a brain on en_US could list ab before a-c. Only the order changes; the counts are the same. PGLite brains see no change.
