---
kind: fix
---
A bare none entry in GBRAIN_SOURCE_BOOST now drops the built-in source boosts, the same way it already did in search.source_boosts. Before, the env value skipped none silently and all the default boosts (originals/ up, daily/ and archive/ down, and the rest) stayed on, so GBRAIN_SOURCE_BOOST="none,wiki/:1.3" still applied every default. Now it weights only wiki/. none in the env value drops only the defaults; a brain's own search.source_boosts entries stay, and the env value still wins over them per prefix. If you set none in GBRAIN_SOURCE_BOOST and relied on the defaults staying, remove the none entry.
