---
kind: fix
---
On a Postgres brain whose database uses a non-C collation, gbrain access group list (the groups and each group's members) and the pages that the gbrain access member rm and group rm previews list now come in byte order, the same order PGLite gives. Before, the order followed the database locale. Only the order changes; the lists hold the same entries. PGLite brains see no change.
