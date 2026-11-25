**An error from `gbrain engine shadow bench --import` now points at the page that explains the command.**

### Fixed
- Every refusal and storage error from `gbrain engine shadow bench --import` names `docs/guides/engine-shadow-bench.md` as its docs pointer. Before, it named the Rust engine shadow mode section of `docs/ENGINES.md`, which no longer describes the bench command since that text moved to the guide. Nothing else about the error changed.
