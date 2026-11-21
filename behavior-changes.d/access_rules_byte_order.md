---
kind: fix
---
On a Postgres brain whose database uses a non-C collation, the folder rules that gbrain access rule list and gbrain access rule status show, the pending prefixes, and the pages that the gbrain access apply preview lists now come in byte order, the same order PGLite gives. Before, the order followed the database locale. Only the order changes; the lists hold the same entries. PGLite brains see no change.
