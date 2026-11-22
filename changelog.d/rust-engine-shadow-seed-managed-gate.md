**`gbrain engine shadow seed` now refuses a brain that uses managed storage, before it creates anything.**

### Changed
- The Rust engine never holds managed storage, so a seed of such a brain copies data nothing can use. `gbrain engine shadow seed` (and `seed --json`, which also prints the error on stdout) now refuses it with `engine_shadow_refused` (`managed_storage`, exit 3) and tells the agent to ask the user. It checks first: a refused seed creates no shadow directory, no Rust store and no `seed.json`, and never starts its snapshot.
- A brain whose storage mode cannot be read, or that cannot be opened, is refused the same way instead of passing, and the refusal carries the error.
