**On the Rust engine, `gbrain access rule migrate` moves a source's folder rules between the database and git.**

### Fixed
- On a brain with the Rust engine, `gbrain access rule migrate` (and its preview) now works as on PGLite and Postgres: `--to database` from no store, `--to git` on a source with a git work tree, resuming a migration that stopped part way, and the refusal to move the other way while one is unfinished. Before, it stopped with a refusal before writing anything, so a Rust brain could not change where a source keeps its folder rules.
