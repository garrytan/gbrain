**Fixed: `gbrain engine swap --plan` now reads the shadow's status, so its readiness verdict reflects what the shadow measured.**

### Fixed
- The swap plan was never given the shadow status, so every readiness criterion read as missing and the plan could never say READY. It now reads the same document `gbrain engine shadow status --json` prints for this brain.
- A brain with no shadow now gets `NOT READY` with reason `no_shadow` and a pointer to `gbrain engine shadow start`, instead of `writer_coverage_unknown`.
