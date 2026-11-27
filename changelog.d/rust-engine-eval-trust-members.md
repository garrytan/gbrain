**The memory-trust evals can now set up and score a brain on the Rust engine, and their pause of managed persistence no longer turns a classic brain managed.**

### Added
- New engine members give the memory-trust evals the reads they ran as raw SQL, on PGLite, Postgres and the Rust engine. They read facts by id with their expiry and successor, the live facts of a source by exact text, and every page with its id. They also answer the catalog probes and scan every stored text value for a token, with an option that leaves out expired and deleted rows.
- On the Rust engine the scan reads every stored record. It finds the same tokens about the same pages, but a hit's table and column names can differ from the SQL engines.

### Fixed
- The evals' pause of managed persistence now restores the exact prior state. Before, the evals turned persistence back on unconditionally, so a classic brain became managed. An activation or deactivation that runs during the pause is kept and reported. Only one pause at a time is supported per brain. If a pause ends before its restore, `gbrain sources writer activate` turns managed persistence back on.
- On the SQL engines the text scan refuses, and names the tables, when the database role cannot read every row of a table it scans. An empty answer no longer reads as "the text is gone".
