**Retrieval Reflex health checks no longer wait for unrelated diagnostics.**

### Fixed
- Run only the retrieval-reflex doctor check when checking the integration or following its setup instructions. Slow or failing checks for other features no longer cause a false integration failure. Reported by @ethanbeard in #9228; contributed by @johnerik.
