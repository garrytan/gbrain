**Search diagnosis reports the source filter it used.**

### Fixed
- `gbrain search diagnose --json` reports `source_id: null` when the search has no source filter. The text report also names the active filter.

<!-- behavior-change: search_diagnose_source_filter -->
