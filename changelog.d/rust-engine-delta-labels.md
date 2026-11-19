**On a Rust brain, `gbrain delta` and the other proactive context surfaces now label each page with the trust tier and origin it was written with.**

### Fixed
- `gbrain delta` (and the turn context and retrieval reflex that share its page labels) read each page's trust tier through a raw SQL statement the Rust engine cannot run, so on a Rust brain every page came back as tier `unknown` with origin `unrecorded`. The read now goes through the typed page trust member every engine serves, and the labels match Postgres and PGLite. A proactive read with a trust floor no longer fails its page arm on a Rust brain for the same reason.
