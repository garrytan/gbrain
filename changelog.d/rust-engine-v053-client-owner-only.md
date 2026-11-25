**On the experimental Rust engine, an upgrade that runs while `gbrain serve` owns the brain no longer wedges the v0.53.0 shared-content step or fails later upgrades; nothing selects the Rust engine yet, so PGLite and Postgres brains are unchanged.**

### Fixed
- When `gbrain apply-migrations` runs as a client of a Rust brain's serve, the v0.53.0 migration cannot read the owner-only skill store. It now names that source as host action (`owner_unavailable`: run the upgrade with the serve stopped) instead of a conflict, so the run is never recorded as partial and never counts toward the three-partial wedge that made later upgrades exit 1.
