**`gbrain core add` and `gbrain core remove` now work on a Rust brain instead of refusing.**

### Fixed
- On a brain whose engine does not run raw SQL (the Rust engine), `gbrain core remove <slug>` used to refuse before changing anything, because it also closes the page's pending remote-edit notices and a Rust brain keeps no notices. It now takes the page out of core and prints the same "Now out of core" line; there is no notice to close. PGLite and Postgres are unchanged: they still close the page's pending notices, with the same output.
- `gbrain core add <slug>` on a Rust brain left a stuck write behind and the page stayed out of core, because saving a core page took its source locks with raw SQL. It now takes them through the engine's typed lock, so the page is marked core and the same "Now in core" line prints. PGLite and Postgres run the same lock statement as before.
- Still refused on a Rust brain: a remote edit of a core page while `memory.core.remote_edit` is `notify` (the default), `gbrain core diff` and `gbrain core ack`. The Rust store keeps no notice table, so these name `raw_sql` in their refusal. The edit is not applied.
