# CoE contract fixtures

`valid/v1.json` contains one standalone example for every v1 top-level contract. The examples use
synthetic identifiers and placeholder content only.

`invalid/v1-mutations.json` defines deterministic mutations against those examples. Tests clone
the named valid fixture, apply each mutation, and assert the stable error code. This keeps invalid
cases small while making their single violated rule explicit.

`pilot/science-one-coe/manifest.json` is the bounded Phase 2 acquisition manifest. Its public entries
are official primary/artifact pages; `architecture-notes.md` is explicitly marked as internal
derived material and must not be cited as primary evidence.
