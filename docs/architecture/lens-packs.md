# Tenant Schema Lenses

Cortex can expose different schema "lenses" over the same tenant brain without
changing the authorization model. A lens is a curated schema-pack view for a
workflow such as customer success, engineering knowledge, investment diligence,
or support operations.

## Principles

- Lenses are tenant configuration, not separate products.
- Source scoping still wins over lens selection.
- A lens can add page types, filing rules, calibration domains, and extraction
  hints.
- Agents request lens changes through audited control-plane operations.

## Examples

| Lens | Adds |
| --- | --- |
| Customer success | accounts, renewals, stakeholders, risks, next actions |
| Engineering | services, incidents, ADRs, ownership, migration notes |
| Diligence | theses, bets, companies, founders, evidence packets |
| Support | issues, customer messages, workaround state, escalation rules |

## Runtime Behavior

The active tenant schema controls how ingestion files pages and how retrieval
filters types. Lenses should never bypass OAuth client source access, team
permissions, or skill policies.

## Deferred Work

- Console UI for reviewing detected lens candidates.
- Runtime package templates for common tenant lenses.
- Per-source lens federation for queries that cross team boundaries.
