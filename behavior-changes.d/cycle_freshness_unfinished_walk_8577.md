---
kind: fix
---
Doctor's cycle_freshness check no longer reports a source walked in bounded windows as fully cycled while the walk is unfinished. When the last window stopped at its page limit and live pages remain after its cursor, the check's message notes the number of pages left and details.source_windows names each cursor; the walk alone never turns the check to a warning or offers a fix, since the next cycle continues it. The windows and their cycle timestamps are unchanged.
