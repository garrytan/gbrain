# Atom source-collision audit and repair plan

This is a non-destructive operator plan for atom rows created before page-derived
atom identity retained the full `source_slug`. It is not an automatic migration
and it does not authorize changes to a live brain.

**Say to your agent:** *"Audit my brain for atom-source collisions and show me a
read-only repair plan; do not mutate anything."*

## Safety contract

- Discovery is read-only. Run it against a restored backup or a read replica
  first; if it must run against the primary, use a read-only connection and a
  transaction that is rolled back.
- Produce and review a dry-run manifest before any write. The manifest is an
  artifact, not permission to apply it.
- Take an engine-native, point-in-time backup after writers are quiesced and
  verify that it restores into a separate test location. Row exports are useful
  evidence but are not a substitute for the full backup.
- Require explicit human approval of the manifest and backup identifier before
  every mutation phase. A future repair command must default to dry-run and
  require an explicit apply flag plus the approved manifest digest.
- Do not infer missing atom text, quotes, or ownership. Preserve ambiguous rows
  until a human selects a source or approves re-extraction.

No repair command is shipped by this change, and no production SQL should be
executed as part of implementing it.

## Phase 1: read-only discovery

Start from `atom-provenance` edges because the historical failure left edges
from multiple source pages pointing at the one overwritten atom. The following
query is SELECT-only and returns one row per observed origin:

```sql
WITH atom_origins AS (
  SELECT
    atom.source_id AS atom_source_id,
    atom.slug AS atom_slug,
    atom.frontmatter->>'source_slug' AS stored_source_slug,
    atom.frontmatter->>'source_hash' AS stored_source_hash,
    source.source_id AS origin_source_id,
    source.slug AS origin_slug,
    substring(source.content_hash from 1 for 16) AS current_source_hash
  FROM links edge
  JOIN pages source ON source.id = edge.from_page_id
  JOIN pages atom ON atom.id = edge.to_page_id
  WHERE edge.link_source = 'atom-provenance'
    AND atom.type = 'atom'
    AND atom.deleted_at IS NULL
)
SELECT
  *,
  count(*) OVER (PARTITION BY atom_source_id, atom_slug) AS origin_count,
  CASE
    WHEN stored_source_slug IS DISTINCT FROM origin_slug
      THEN 'binding_edge_disagreement'
    WHEN stored_source_hash IS DISTINCT FROM current_source_hash
      THEN 'source_changed_or_hash_disagreement'
    ELSE 'binding_matches_current_source'
  END AS observation
FROM atom_origins
ORDER BY atom_source_id, atom_slug, origin_source_id, origin_slug;
```

The dry-run analyzer should also report atom rows with `source_slug` but no
matching live source page or no matching provenance edge. Those are candidates,
not proof of collision: old imports, deleted sources, and interrupted extraction
can produce the same shape.

Write a stable JSON or CSV manifest containing:

- brain snapshot identifier and schema version;
- atom `(source_id, slug)`, row id, generation, content hash, full frontmatter,
  body, chunks, tags, aliases, versions, and every incident link;
- every candidate origin `(source_id, slug)`, its current content hash, and
  whether a historical version matching `stored_source_hash` is available;
- classification, evidence, proposed action, and an `approved: false` field;
- a cryptographic digest of the canonicalized manifest.

Re-running discovery against unchanged data must produce the same candidate
keys and evidence. Sort all arrays and rows before hashing the manifest.

## Phase 2: ambiguity review

Classify each candidate independently:

- **Multiple origin edges:** high-confidence evidence that one legacy atom slug
  represented more than one source page. The stored atom only proves the last
  surviving binding; it does not recover overwritten atom bodies or quotes.
- **One edge and matching binding:** no collision evidence. Leave it alone.
- **Binding/edge disagreement:** ambiguous. Preserve the row and inspect page
  versions, extraction receipts, backups, and source text.
- **Source hash disagreement:** a source may simply have changed since
  extraction. Do not call this a collision without independent evidence.
- **Missing source or edge:** ambiguous. Never manufacture provenance.

For a multiple-origin candidate, the human chooses one of: preserve the legacy
row as historical evidence; assign it to the one origin supported by versions
or receipts; re-extract selected origins through the fixed runtime; or defer.
Re-extraction is not exact historical recovery because model output can change.

## Phase 3: approved, staged repair

Only after the backup restores successfully and the manifest is approved:

1. Re-read every candidate and compare its id, generation, binding, links, and
   content hash with the approved manifest. Any drift aborts that candidate.
2. Perform additive recovery first. Re-extract approved source pages through
   the fixed runtime so each receives its collision-proof atom identity and an
   idempotent provenance edge. Do not delete or rename the legacy row yet.
3. Verify every new atom is independently addressable and has the approved
   `source_slug`, final `source_hash`, exact observed `source_quote`, chunks,
   and exactly one matching same-source provenance edge.
4. Stop for a second human checkpoint. Only then may an approved cleanup
   transaction tombstone a superseded legacy atom or remove obsolete legacy
   edges. Never hard-delete it in the first repair pass.
5. Re-run discovery and the verification report. Unexpected candidates or
   changed counts abort cleanup.

The mutation boundary should be one candidate group per database transaction.
External re-extraction cannot share that transaction, which is why additive
recovery and destructive cleanup are separate approval phases.

## Idempotency and rollback

- New page-derived atom slugs are deterministic from the complete source-page
  locator plus the existing title components; retries address the same row.
- Provenance insertion uses the existing unique edge key, so retrying produces
  exactly one matching edge.
- Every write must use compare-before-write guards from the approved manifest.
  Desired state is a no-op; unexpected state is a conflict, never an overwrite.
- Record created row ids and edge ids in an append-only repair receipt. This
  supports transactionally removing only additive repair output if cleanup has
  not begun.
- The authoritative rollback boundary is the verified full backup. If any
  destructive cleanup committed, restore that backup into a separate location,
  validate it, and use the normal engine-specific restore procedure; do not
  improvise inverse SQL on the live primary.
