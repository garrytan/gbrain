---
kind: fix
---
On a Postgres brain whose database uses a collation other than C (for example en_US.UTF-8), the page purge receipt's store report now lists the first 20 items of each named-row probe and of the effect probe in byte order. Before, that list followed the database collation, so its order, and which 20 items it showed when more than 20 matched, depended on how the database was created. PGLite brains and Postgres brains created with the C collation list the same items in the same order as before. Only the listed items change; the counts and the purge itself do not.
