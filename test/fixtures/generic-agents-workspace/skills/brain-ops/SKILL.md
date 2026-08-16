---
name: brain-ops
description: Core read/write cycle for the generic agent-workspace fixture.
triggers:
  - any brain read/write/lookup/citation
writes_pages: true
writes_to:
  - people/
  - companies/
---

# brain-ops

Fixture skill for `test/e2e/workspace-generic-compat.test.ts`.
Example filing targets: `people/alice-example.md`, `companies/acme-example.md`.
