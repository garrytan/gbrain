**Code callers, callees and chunk edges now come back in a fixed order on PGLite and Postgres.**

### Fixed
- `gbrain code-callers` and `gbrain code-callees` listed edges in the order the database happened to store them, so a limited list could drop a different edge after an edit. Resolved edges now come first, then unresolved ones, each in the order they were added.
- The edges of one code chunk came back in storage order. They now come in the order they were added, before each table's limit.
