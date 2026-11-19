**`graph-query` now lists edges between the same two pages in one fixed order on every engine.**

### Fixed
- When two links join the same pages at the same depth with different link types, `graph-query` and `traverse_graph` paths now sort them by link type in byte order, then by link id. Before, Postgres could return them in a different order from one run to the next. PGLite, Postgres and the Rust engine now give the same order, and Postgres uses the same plan and indexes as before.
