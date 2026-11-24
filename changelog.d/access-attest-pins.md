**Tests now pin that `gbrain auth rescope --token` and `--attest-sources` give the same answer on PGLite, Postgres and the Rust engine.**

### Changed
- Tests and docs only, no behavior change. New parity cases cover the scope-source marks and refusals, the `rescope --token` handler on every engine, and the two places Rust still stops (the bare-name rescope, and `verifiedMember` with no engine). The old note that `rescope --token` stops on raw SQL on Rust is gone from the docs. The bare-name form `gbrain auth rescope <name>` still stops on Rust, and a test now pins that.
