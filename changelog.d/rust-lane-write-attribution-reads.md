**On the experimental Rust engine, `gbrain attribution` and the MCP `get_write_attribution` tool now answer who wrote a page, its versions, a fact, a take or a timeline entry, the same as on PGLite and Postgres.**

### Changed
- The eight attribution reads moved from raw SQL in the operation into five typed engine members. PGLite and Postgres run the same SQL as before.
- The Rust store now stamps the request and principal of every page, version, fact, take and timeline write, as the SQL triggers do.
- On the Rust engine, naming an OAuth client or a legacy token refuses with `engine_capability_missing`, because that store keeps no client or token table.
