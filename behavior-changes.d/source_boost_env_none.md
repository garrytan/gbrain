---
kind: fix
---
A `none` entry in the `GBRAIN_SOURCE_BOOST` environment variable now drops the built-in source boosts, as it already did in the `search.source_boosts` config key. Before, the entry was ignored and the built-in boosts and demotions stayed active. If a process sets `GBRAIN_SOURCE_BOOST` with a `none` entry, its search ranking changes after this upgrade: only the brain's own `search.source_boosts` entries and the prefixes listed in the variable are weighted. Processes without a `none` entry rank exactly as before.
