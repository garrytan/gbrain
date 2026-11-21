**`none` in `GBRAIN_SOURCE_BOOST` now drops the built-in source boosts, the same as it does in `search.source_boosts`.**

### Fixed
- `GBRAIN_SOURCE_BOOST="none,wiki/:1.3"` ranks with only the boosts you list. Before, the `none` was ignored and every built-in boost and demotion (`originals/`, `daily/`, `archive/` and the rest) stayed on. `none` drops only the built-in defaults: a brain's own `search.source_boosts` entries still apply, and the env var still wins per prefix.

<!-- behavior-change: source_boost_env_none -->
