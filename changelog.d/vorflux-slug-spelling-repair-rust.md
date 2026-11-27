**`gbrain repair slug-spelling` previews on a Rust brain and says that no page needs to move, as on Postgres and PGLite.**

### Fixed
- On a Rust brain the slug-spelling repair stopped with an unsupported-engine refusal before it read anything. Its preview reads are now typed engine calls the Rust engine serves, so the preview runs and lists nothing to move: a Rust brain stores every page under its normal name. The writes that move a page stay unsupported on a Rust brain, where no page ever needs them.
