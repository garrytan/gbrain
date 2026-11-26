**Shadow mode's help now says a brain that cannot be opened stops the seed.**

### Fixed
- `gbrain engine shadow --help` now says that a brain that cannot be opened stops `seed` with exit 1 (`could not open the brain (pglite_busy)` while another process holds a PGLite brain) and that nothing is written. The command already behaved this way; only the help text was missing it.
