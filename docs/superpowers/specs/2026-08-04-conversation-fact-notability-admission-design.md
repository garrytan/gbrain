# Conversation fact notability admission

## Purpose

Make GBrain enforce notability before embedding or durable storage. This
closes the historical backfill path that currently embeds every model-returned
candidate and filters `low` facts only afterwards.

## Contract

The shared conversation-fact extractor accepts an explicit admission policy.

- Historical conversation backfill admits `high` and `medium` candidates.
  Valid `low` candidates are counted and discarded before embedding. Missing,
  null, or unknown tiers make the strict extraction outcome malformed so the
  segment remains retryable rather than silently becoming `medium`.
- Live sync admits only `high` candidates. Valid medium/low candidates and
  malformed tiers are discarded before embedding, while other valid high
  candidates in the same response still proceed.
- Callers that do not select a policy retain the existing legacy behavior.

The extractor returns the count of policy-rejected valid candidates with a
successful outcome. Historical backfill maps that count to its existing
`facts_low_notability_rejected` result field. Internal terminal and
non-extractable audit rows remain outside the policy and keep their intentional
`low` notability.

## Boundaries

- No prompt, model, provider, entity-resolution, deduplication, or historical
  cleanup change.
- Do not alter or delete already stored facts. A retrospective cleanup, if ever
  desired, requires a separate previewable and explicitly approved operation.
- Do not introduce a general parser rewrite: strict malformed-tier behavior is
  limited to the historical admission policy, while sync safely drops malformed
  candidates.

## Tests and proof

Tests must prove that rejected facts never invoke embedding, historical
high/medium candidates are stored with contiguous row numbers, invalid
historical tiers leave a page retryable, and high-only sync does not embed or
store medium/low/invalid candidates. Existing CLI and cycle result aggregation
remain covered by their typed result paths; add focused behavioral coverage
where a direct public output can be exercised without new mocking seams.
