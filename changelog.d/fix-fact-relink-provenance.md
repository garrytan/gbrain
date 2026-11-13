**Fact relink preserves the source attribution and validity timestamps.**

### Fixed
- An entity link retains the fact's stored origin, trust and millisecond validity.
- Facts whose validity or stored fields cannot be preserved by the fence remain active and unlinked.
- Search chunks use the lower trust of a public fact moved onto a more trusted page.

<!-- behavior-change: facts_relink_preserves_provenance_9260 -->
