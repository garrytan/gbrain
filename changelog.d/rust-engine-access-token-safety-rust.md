**On the Rust engine, one corrupt token record no longer blocks every other sign-in, and `gbrain access serves several --yes` no longer leaves a half-finished result.**

### Fixed
- On a brain with the Rust engine, signing in with a legacy token or member key skips an unreadable token record that is not the token being checked, so other tokens still sign in. If the unreadable record is the token being checked, the sign-in is still refused. Before, a single unreadable record refused every legacy-token sign-in.
- On the Rust engine, recording a token's last use no longer opens a write for each request when the once-a-minute limit means nothing is written.
- On a brain with the Rust engine, `gbrain access serves several --yes` now refuses before it writes anything when a key it keeps needs more sources to read, with an `engine_capability_missing` error that says what to do: run it on a PGLite or Postgres brain, or wait for a release that supports it. Before, it added the members, the folder rules and the new keys and then stopped, leaving a partial result. PGLite and Postgres are unchanged.
