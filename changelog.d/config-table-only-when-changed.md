**On Postgres, reading the config table re-sends its rows only when they changed.**

### Fixed
- `getAllConfig()` runs on every MCP request, CLI start and publication, and re-sent the whole table each time (on one hosted brain ~20 KB, about 0.5 GB of egress a month). The Postgres engine now runs one statement that returns the table's content hash and returns the rows only when that hash differs from the last read; an unchanged table costs one short row. Still one round trip, still exactly fresh.
