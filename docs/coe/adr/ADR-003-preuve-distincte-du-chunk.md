# ADR-003: Evidence is distinct from retrieval chunks

- Status: Accepted
- Date: 2026-08-04

## Context

Retrieval chunks are tuning artifacts. Their boundaries can change when tokenizers, embeddings, or
ranking strategies change, while citations require durable locations.

## Decision

`EvidenceItem` is a canonical, citable unit with a raw locator and normalized span. Retrieval
chunks are projections that may point to one or more evidence items. Chunk identifiers must never
be used as evidence identifiers.

## Consequences

- Retrieval can be retuned without invalidating citations.
- Every released answer claim resolves to durable evidence.
- A projection must preserve the mapping from a retrieved chunk back to canonical evidence.
