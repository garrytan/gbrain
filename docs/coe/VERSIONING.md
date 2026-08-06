# CoE Lite contract versioning

CoE contracts use semantic versions in the required `schema_version` field. Version `1.0.0` is
the inaugural released contract.

## Reader and writer policy

- Writers emit exactly `1.0.0`.
- Readers accept exactly `1.0.0`.
- Missing or malformed versions fail normal contract validation.
- Any other declared version fails with `unsupported_schema_version`.
- Unknown fields are never a compatibility mechanism; they fail with `unknown_field`.

There is no fabricated v0 upgrader. Therefore N-1 compatibility is not applicable to v1. Before
v2 can be accepted, the change must include an explicit, deterministic, fixture-tested v1-to-v2
upgrader and keep a v1 reader for the stated support window.

## Change classes

- Patch: documentation, diagnostics, or a semantic correction that accepts and emits the same
  record set.
- Minor: backward-compatible additions that remain representable to all supported readers. Since
  objects are strict, adding a field still requires a coordinated reader release.
- Major: removals, renames, changed meanings, changed identity payloads, or relaxed/tightened
  acceptance that affects stored records.

Canonicalization profile changes always require a new profile name and a major contract decision;
existing identifiers are never silently recomputed.

## Release checklist

1. Update executable schemas and generated artifacts together.
2. Add valid and invalid fixtures for every changed rule.
3. Demonstrate deterministic canonicalization and artifact generation.
4. Document read/write compatibility and any upgrader.
5. Re-review all accepted ADRs affected by the change.
6. Keep release fail-closed until the contract gate passes.
