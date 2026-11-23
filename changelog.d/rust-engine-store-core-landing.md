**The experimental Rust storage engine's code is updated to its latest tested state, part 1 of 2; nothing changes for users yet.**

### Changed
- The Rust engine's storage core now includes its newer key-value layers, page, link, fact, keyword and vector reads and writes, and write guards. Its design docs and a few smaller modules follow in part 2. It is still not selectable as an engine, so no brain behaves differently today.
