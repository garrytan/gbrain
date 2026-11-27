**The Rust engine now gives the same answers as the built-in engines in five more places, and an alias write that fails no longer loses the old aliases.**

### Fixed
- Rust engine: a long page stored in segments that has no chunks yet now reports its size, so it counts as a page with content that still needs chunks, as on the built-in engines.
- Rust engine: code search, the code-readiness check and saved search hits now work when the caller asks for safe chunks only, and return only pages chunked at or above the safe chunker version. Before, the Rust engine refused these reads.
- Rust engine: a page, page version, fact or take write that carries a write request id that is not a UUID is now refused and writes nothing, as on the built-in engines. Before, only a timeline write was refused.
- Replacing a page's derived aliases outside a transaction now runs as one unit on every engine: when the new aliases are refused, the old ones stay. Before, the built-in engines could delete the old aliases and then refuse the new ones.
- A frontmatter alias row sent to the derived-alias write is now stored the same way on every engine: not case-sensitive and with no stored text, as the other frontmatter alias paths store it. This changes PGLite and Postgres, which stored the row's case flag and text as sent; the Rust engine already stored it this way.

<!-- behavior-change: derived_alias_frontmatter_row_lane6 -->
