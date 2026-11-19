**`gbrain doctor` and `gbrain search modes` now read the synopsis tier setting on a Rust brain, and list synopsis sources in one order on every engine.**

### Fixed
- On a Rust brain, the synopsis tier's configuration read (used by `gbrain doctor` and `gbrain search modes`) no longer stops on the raw SQL refusal. It reports a page whose trusted frontmatter picks the per-chunk synopsis tier, as PGLite and Postgres do.
- On a Postgres database with a linguistic collation (for example en_US), the synopsis sources now list in byte order, as on PGLite: a hyphenated source id no longer sorts as if the hyphen were missing.
