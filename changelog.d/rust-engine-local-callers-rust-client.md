**On the experimental Rust engine, tests now show that `gbrain bootstrap verify` and the Apple Contacts fact sync reach a brain's owner process as local callers, and the error a second process gets for a page or memory write no longer says that write is sent to the owner; nothing selects the Rust engine yet, so PGLite and Postgres brains are unchanged.**

### Changed
- The `engine_capability_missing` advice a second process of a Rust brain gets now says that a page write, a memory write or an import cannot run from that process yet. Before, it said such writes are sent to the owner as one request, which no code does yet.
