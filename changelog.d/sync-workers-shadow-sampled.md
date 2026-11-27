**Shadow mode now compares the page writes of a large Postgres sync or import, not only the ones the main connection makes.**

### Fixed
- A Postgres `gbrain sync` of more than 100 files, or `gbrain sync --concurrency N` or `gbrain import --workers N` with N above 1, writes through extra worker connections that shadow mode never saw, so none of those saves were sampled, followed into the Rust store or counted toward the swap check. Each worker that opened the same database as the main connection now shares its mirror, follower and writer observer and has its own write sampler, which finishes its read-backs before the worker disconnects. Nothing to do on upgrade; with shadow mode off nothing changes.
