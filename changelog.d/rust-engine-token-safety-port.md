**On the Rust engine, one damaged token no longer blocks every sign-in, and `gbrain access serves several --yes` no longer half-finishes.**

### Fixed
- On a brain with the Rust engine, signing in with a legacy token or member key skips a token record that cannot be read when it is not the token being checked, so other tokens still sign in. If the damaged record could be the token being checked, the sign-in is still refused. Before, one damaged record refused every legacy-token sign-in.
- Recording a token's last use on the Rust engine no longer opens a write for every request when the once-a-minute limit means nothing is written.
- On a brain with the Rust engine, `gbrain access serves several --yes` now refuses before it writes anything when the run adds a folder rule, including the `company/` rule a `--labelled-only` run adds (`engine_capability_missing`). A re-run that only widens the keys it keeps runs on Rust as on PGLite. Before, it added the members and then stopped at the folder rules, leaving a partial result. PGLite and Postgres run it as before.
