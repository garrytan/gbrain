**The Rust engine setup script is safer on shared and already-used machines: each run logs to its own private folder, it ignores `PGHOST`, `PGHOSTADDR` and `PGSERVICE`, and it no longer resets an existing `gbrain` database role.**

### Fixed
- `scripts/dev/rust-engine-bootstrap.sh` now writes each run's step logs to a new private folder, and refuses a `GBRAIN_DEV_LOG_DIR` that another user can write to.
- The script unsets `PGHOST`, `PGHOSTADDR` and `PGSERVICE` for itself, so its database steps always reach the local Postgres 16 cluster.
- The script creates the `gbrain` role only when it is missing. An existing role keeps its password and flags; if it cannot be used, the step fails with a message that names the setting to change.
