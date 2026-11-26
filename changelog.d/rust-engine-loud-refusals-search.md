**On a Rust brain, importing an unchanged image and listing a remote `get_page` fuzzy match no longer stop with an unsupported raw-SQL error. The slug-prefix read of a pinned question is served too.**

### Fixed
- Four reads that search and import callers sent as raw SQL are now typed engine reads. PGLite and Postgres send the same statement text as before, so their answers do not change. The Rust engine now answers each read the same way:
  - the seal check of an image whose bytes did not change (`gbrain import`, `sync`);
  - the distrusted-provenance check of that image (a body write that removed a protected section);
  - the private-only filter of a remote `get_page` fuzzy match's candidates;
  - the newest pages under the slug prefix of a pinned question.
- On a Rust brain, `gbrain questions refresh` of a prefix-scoped question still stops after the prefix read, at the refresh's own evidence reads. A follow-up item serves those.
