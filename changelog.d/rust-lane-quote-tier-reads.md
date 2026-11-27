**The experimental Rust engine now answers `get_tags` for a remote reader, and the remote chronicle reads (`chronicle_day`, `chronicle_on_this_day`, `chronicle_since` and `volunteer_chronicle`) no longer stop with a typed refusal where they look up whether an event's kind needs quoting.**

### Changed
- Both engines gain one storage read, `listPageQuoteTiers`, that reads the stored type and trust tier of the live pages with a slug in the caller's sources (or of listed pages by id). Remote `get_tags` uses it to decide whether to quote a page's tags, and the remote chronicle reads use it to decide whether to quote an event's kind, each in place of its own SQL, so PGLite and Postgres answer exactly as before.
