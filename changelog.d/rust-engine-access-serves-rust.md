**On the Rust engine, `gbrain access serves several` and `gbrain access rule add` work, and `gbrain auth list` shows every token with every column.**

<!-- behavior-change: access_serves_byte_order -->

### Fixed
- On a brain with the Rust engine, `gbrain access serves several` (its preview and `--yes`) adds the members, keeps each member's people folder to that member, and mints each member key, with the same results as PGLite. Before, it stopped with a typed refusal before any write.
- On the Rust engine, `gbrain access rule add` (its preview and its write), `rule rm`, `rule revert` and `rule import` run their full preview, including the open twins in other sources and the held facts a change would move, and print the same output as PGLite. Before, they stopped with a typed refusal before any write.
- On the Rust engine, `gbrain auth list` lists every token with every column, and the open-page count reads each member key's sources. Before, both refused once a token existed.
- On the Rust engine, `gbrain access member add` from the command line no longer stops on the conversation-archive check it runs first.
- On a Postgres brain whose database uses a non-C collation, the unbound credentials, the keys still reading a source and the unlabeled people folders now come in byte order, as on PGLite.
