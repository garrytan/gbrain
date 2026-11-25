**`gbrain doctor` on a Rust brain now reports whether any page is stored under an older spelling of its name, as on Postgres and PGLite.**

### Fixed
- The `legacy_slug_spellings` doctor check warned on every Rust brain that the count was unknown, because its two reads were refused there. Both reads are now typed engine calls the Rust engine serves, so the check answers ok when every page name is in its normal form, which is always true on a Rust brain.
