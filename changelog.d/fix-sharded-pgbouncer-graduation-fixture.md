**Graduation tests work when the PgBouncer server and test shard use different PostgreSQL servers.**

### Fixed

- Create the disposable pooled graduation target through PgBouncer's direct PostgreSQL route so both the direct and pooled connections reach the same database.
