**The experimental Rust engine now answers `get_tags` for a remote reader, so an agent reading a page's tags over MCP no longer stops on it with a typed refusal.**

### Changed
- Both engines gain one storage read, `listPageQuoteTiers`, that reads the stored type and trust tier of the live pages with a slug in the caller's sources (or of listed pages by id). Remote `get_tags` uses it in place of its own SQL to decide whether to quote a page's tags, so PGLite and Postgres answer exactly as before.
