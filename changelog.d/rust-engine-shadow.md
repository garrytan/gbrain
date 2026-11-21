**You can turn on Rust engine shadow mode to compare a sample of your reads against the Rust engine in the background, without changing how your brain answers or writing anything to it.**

### Added
- `gbrain engine shadow start|status|stop|report`. Shadow mode is off by default. When on, the primary engine answers every call first; a sample of reads and searches is then replayed against the Rust engine in a supervised child process, and only content-free comparison rows are kept, in `~/.gbrain/shadow/<brain>/`. Nothing is written to the brain database, the config table or the brain repo. `start` previews a plan and its hash and needs `--yes`. Plan: https://github.com/garrytan/gbrain/pull/9593, Phase S.
- `gbrain engine shadow report` writes a provisional report whose verdict is always NOT READY. This phase compares reads only and the Rust store is not seeded yet.
- `gbrain doctor` check `rust_engine_addon` reports whether the Rust addon is installed and loads, only when shadow mode is on. It never downloads anything.
- `gbrain eval longmemeval` and `gbrain eval brainbench` take `--engine pglite|rust`. With `rust`, a missing or mismatched addon stops the run with its code and reason, and so does a Rust store that cannot yet reset its tables between fixtures. The Rust store is not seeded yet, so the flag stops before any work for now.
