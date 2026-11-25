**You can record every call your brain makes to its storage engine into private files on your own machine, ready for the coming shadow replay of the Rust engine.**

### Added
- `gbrain engine shadow capture on --yes | off | status | delete --yes`. Capture is off by default. When on, every engine call (reads and writes, with their arguments) is recorded in owner-only files under `~/.gbrain/shadow/<brain>/capture/`; results are kept only as hashes. Answers never change or wait on capture. `capture off` or `GBRAIN_SHADOW_CAPTURE=off` stops it at the next write and deletes nothing. Any purge deletes every recording at once, even with capture off. This release only records; replay comes in a later release. Guide: `docs/guides/shadow-capture.md`.

### Fixed
- Shadow mode no longer leaves out an argument field named `signal` (for example in a page's frontmatter) when it records or compares a call; only real cancellation signals are left out.
