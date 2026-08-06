# ADR-002: Separate source identity from snapshot identity

- Status: Accepted
- Date: 2026-08-04

## Context

A logical source can be acquired repeatedly and its bytes can change without changing its
bibliographic identity.

## Decision

`Source` represents the stable logical work. `SourceSnapshot` represents immutable acquired bytes,
identified from the source, content hash, acquisition facts, and identity profile. Normalized
documents and evidence always reference a snapshot, never only a source.

Mutable lifecycle fields, storage location, and projection metadata are excluded from identity
payloads. A superseding snapshot creates a new identifier and preserves the preceding record.

## Consequences

- Citations remain tied to the bytes that were actually inspected.
- Freshness can be evaluated without overwriting older evidence.
- Duplicate byte payloads can be detected independently from logical-source deduplication.
