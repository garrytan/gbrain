**A remote caller can no longer learn that a private page exists, or what its title names, by asking `recall` for facts about that page's slug.**

### Fixed
- Facts about a page are read under several keys: the page's slug, its identity siblings, its title's subject and its bare basename. For a caller that may not read private pages (a remote MCP caller), the title used to come from a page read with no private-page check. So `recall` of a private page's slug returned the world facts saved under its title's subject. A slug with no page returned nothing. Now a private page adds no key for such a caller, so the answer is the same as for a slug with no page. Local CLI reads are unchanged. This applies on PGLite, Postgres and the Rust engine.
