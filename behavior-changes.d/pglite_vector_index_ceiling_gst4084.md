---
kind: add
---
gbrain doctor's pglite_scale check now warns, at any page count, when a PGLite brain's chunk vector index nears what PGLite can build (65% of its build budget, about 200,000 embedded chunks at 1,024 dimensions) and again when it is past it and cannot be built. Before, it warned only on page count, and the documented PGLite range of about 50,000 pages could already hold more chunks than PGLite can index. The fix both warnings carry is the read-only move-to-Postgres plan: gbrain migrate --to postgres --plan --json. Nothing changes on its own.
