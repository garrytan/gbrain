**`gbrain engine shadow start` now refuses a brain that uses managed storage, before it writes anything.**

### Changed
- The Rust engine never holds managed storage, so a brain that uses it can never swap to Rust and a shadow on it measures nothing it could use. `gbrain engine shadow start` (the preview, `--plan` and `--yes`) now refuses such a brain with `engine_shadow_refused` (`managed_storage`, exit 3) and tells the agent to ask the user. It refuses before the Rust addon loads and before any shadow file is created.
- A brain whose storage mode cannot be read, or that cannot be opened, is refused the same way instead of passing, and the refusal carries the error.
- `start` now opens the brain database to read the storage mode, even with `--plan`, so the database has to be reachable. It writes nothing to it.
