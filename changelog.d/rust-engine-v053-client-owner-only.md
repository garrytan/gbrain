**On the experimental Rust engine, an upgrade that runs while `gbrain serve` owns the brain no longer marks the v0.53.0 shared-content step as stuck or makes later upgrades exit 1; nothing selects the Rust engine yet, so PGLite and Postgres brains are unchanged.**

### Fixed
- When `gbrain apply-migrations` runs as a client of a Rust brain's serve, the v0.53.0 migration cannot read the owner-only skill store. It now names that source as host action (`owner_unavailable`: run the upgrade with the serve stopped) instead of a conflict. The run is never recorded as partial, so three such runs in a row no longer stop v0.53.0 until a person resets it, and later upgrades keep exiting 0.
