**The ingest log and the eval capture failure list now return rows written in the same millisecond newest first on every engine.**

### Fixed
- `gbrain` read the ingest log and the eval capture failure list by timestamp only. On the embedded engine (PGLite), the clock ticks in whole milliseconds, so rows written close together could come back oldest first. Both lists now break ties by row id, newest first, on PGLite and Postgres.
