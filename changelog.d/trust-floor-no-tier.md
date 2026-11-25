**A search or page read whose trust floor names no tier now gets a clear refusal instead of a database syntax error.**

### Fixed
- On PGLite and Postgres, a `minTrust` floor that is not one of the trust tiers (a number such as `0.5`, an unknown name such as `trusted`, or a name in the wrong case) made the read build `trust_tier IN ()` and fail with SQL error 42601. The read now refuses before any SQL runs, with code `invalid_argument` and the message `minTrust: "<floor>" names no trust tier`, the same refusal the native Rust store gives (the Rust engine adapters on master still refuse `minTrust` as unsupported). Valid floors build the same SQL and return the same rows as before. The `min_trust` operation parameter was already checked; this guard covers every caller that builds the SQL.
