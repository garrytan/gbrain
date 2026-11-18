**Ontology conflicts, raw enrichment data and page files now come back in a fixed order on PGLite and Postgres.**

### Fixed
- An ontology conflict listed its competing values in the order the database happened to store them, so the list could change after an edit. The values now come in the order they were recorded.
- Raw enrichment data for a page came back in storage order. It now sorts by source, then by the enrichment provider name.
- Files attached to a page at the same moment came back in storage order. They now sort by upload time, then by the order they were added.
