**`gbrain core remove` now takes a page out of core on a Rust brain instead of refusing.**

### Fixed
- On a brain whose engine does not run raw SQL (the Rust engine), `gbrain core remove <slug>` used to refuse before changing anything, because it also closes the page's pending remote-edit notices and a Rust brain keeps no notices. It now takes the page out of core and prints the same "Now out of core" line; there is no notice to close. PGLite and Postgres are unchanged: they still close the page's pending notices, with the same output.
