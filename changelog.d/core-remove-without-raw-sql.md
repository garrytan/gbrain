**`gbrain core add` and `gbrain core remove` now work on a Rust brain instead of refusing.**

### Fixed
- On a brain whose engine does not run raw SQL (the Rust engine), `gbrain core remove <slug>` used to refuse before changing anything, because it also closes the page's pending remote-edit notices and a Rust brain keeps no notices. It now takes the page out of core and prints the same "Now out of core" line. PGLite and Postgres are unchanged: they still close the page's pending notices, with the same output.
- `gbrain core add <slug>` on a Rust brain left a stuck write behind and the page stayed out of core, because saving a core page took its source locks with raw SQL. It now takes them through the engine's typed lock, so the page is marked core and the same "Now in core" line prints. PGLite and Postgres run the same lock statement as before.
