**`gbrain doctor` stops calling a connector source "never synced" while its first sync is still working through a provider's daily limit.**

<!-- behavior-change: sync_freshness_usage_limit_gst3452 -->

### Fixed
- A Gmail source read through gbrain.io (or any Google source on a tight quota) can take several runs to finish its first sync, because each run stops when the provider's usage limit runs out and the next one resumes. `gbrain doctor` failed sync_freshness for such a source with `sync_no_successful_sync`, and for a source whose first sync job was running between two sync locks, which also tripped the upgrade's doctor check and held writers for no reason. A run that stopped only at the limit now records `stopped_on: usage_limit`, and doctor reads it as `warn` (`sync_usage_limited`) while the last such run is inside the fail age. A running sync job reads `warn` (`sync_first_run_in_progress`). Failed items, held files and old attempts still fail.
