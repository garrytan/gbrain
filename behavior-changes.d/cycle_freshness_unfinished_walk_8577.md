---
kind: fix
---
Doctor's cycle_freshness check no longer reports a source walked in bounded windows as fully cycled while the walk is unfinished. When the last window stopped at its page limit and live pages remain after its cursor, the check warns with the number of pages left and a gbrain dream --source fix (a source with sync off gets a note instead), and details.source_windows names each cursor. The windows and their cycle timestamps are unchanged.
