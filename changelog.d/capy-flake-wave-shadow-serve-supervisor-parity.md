**Four tests that failed on busy CI machines for no real reason now fail only when something is actually broken.**

### Fixed
- The shadow-checks test for a commit that becomes visible after the freshness capture no longer fails on a loaded machine. It used to rely on a 100 ms commit delay. It now holds the writer at that point until the capture is taken.
- The `serve --http` limits test no longer throws `PGLite not connected` after it finishes. It now reads its last search response to the end before the engine closes.
- The supervisor test that kills an owner's process group no longer reads a worker pid of 0. The worker writes its pid to a side file and renames it into place.
- The release build's bytecode parity check no longer fails when a recency-weighted score crosses a rounding boundary between the two runs. Clock-driven decimals are compared to 5 decimal places, and a real difference still fails. A failing step now prints a short diff of the two outputs.
