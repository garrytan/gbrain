# Structural graph reconciliation

`gbrain reconcile-structure` builds a deterministic containment graph for
multi-source brains without using an LLM or inventing semantic relationships.

```bash
gbrain reconcile-structure --dry-run --json
gbrain reconcile-structure
gbrain reconcile-structure --source wiki
```

The reconciler creates a global root, one root per source, and directory index
pages where an authored `README` or `index` page does not already exist. Every
generated page carries `frontmatter.generated_by: derived-path`; every generated
edge carries `link_source=derived-path` and `link_type=contains`.

Reconciliation is transactional, idempotent, source-qualified, and preserves
all manual, markdown, frontmatter, mention, and custom-provenance edges. Flat
directories are split into stable hash-prefix buckets so no generated node has
more than 64 direct children. Generated pages are timeline-ineligible.

## Health-score semantics

The weighted score counts only live pages and live-endpoint links. Timeline
coverage uses pages that actually require history: `person`, `company`, and
`project` pages, plus pages with `timeline_required: true`. Set
`timeline_required: false` to explicitly opt an otherwise eligible page out.
Timeless notes, extraction receipts, and generated structural indexes do not
need fabricated events.

`gbrain orphans` now defaults to the same islanded-page definition used by the
health score: no live inbound and no live outbound edge. Use
`gbrain orphans --mode no-inbound` for the stricter legacy report.

## Operational sequence

1. Run `reconcile-structure --dry-run --json` and inspect planned counts.
2. Back up PostgreSQL before the first live reconciliation.
3. Run reconciliation, then `gbrain embed --stale` for generated index pages.
4. Run full `gbrain doctor` and the operator retrieval evaluation.
5. Re-run reconciliation after source syncs; it only replaces its own
   `derived-path` edges.
