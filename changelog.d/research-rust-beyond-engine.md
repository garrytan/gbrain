**A new research page measures which parts of gbrain beyond the storage engine are worth moving to Rust.**

### Documentation
- `docs/research/RUST_BEYOND_ENGINE.md` profiles cold CLI start, MCP round trips, a sync of 1,000 changed files, the mention pass, doctor, migrations, jobs and repair on 10,000-page PGLite and Postgres brains, and marks each subsystem as move, keep or later.
- The page finds that the database takes most of the CPU on every PGLite path, and that the release binary spends about half a second parsing its bundle before each command. A bytecode build removed that cost in a local test.
- The research index lists the page.
