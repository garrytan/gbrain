# Atom source-collision audit and repair plan

This is a non-destructive operator plan for atom rows created before page-derived
atom identity retained the full `source_slug` and full source content hash. It
is not an automatic migration and it does not authorize changes to a live brain.

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
from multiple source pages pointing at one overwritten atom. Classification is
by **distinct source-page identity** (`pages.id`, whose logical identity is
`(source_id, slug)`) within the atom's source scope. It is never a count of
provenance rows: one source page can have several edge variants. The following
SELECT retains every edge id and variant as evidence while attaching the
distinct-identity counts:

```sql
WITH edge_evidence AS (
  SELECT
    atom.id AS atom_id,
    atom.source_id AS atom_source_id,
    atom.slug AS atom_slug,
    atom.frontmatter->>'source_slug' AS stored_source_slug,
    atom.frontmatter->>'source_hash' AS stored_source_hash,
    edge.id AS edge_id,
    edge.from_page_id,
    edge.to_page_id,
    edge.link_type,
    edge.context,
    edge.link_source,
    edge.link_kind,
    edge.origin_page_id,
    edge.origin_field,
    edge.resolution_type,
    edge.created_at AS edge_created_at,
    source.id AS source_page_id,
    source.source_id AS origin_source_id,
    source.slug AS origin_slug,
    source.deleted_at AS origin_deleted_at,
    substring(source.content_hash from 1 for 16) AS current_source_hash,
    source.id IS NULL AS source_endpoint_missing,
    source.source_id IS NOT DISTINCT FROM atom.source_id AS endpoint_in_atom_scope
  FROM links edge
  JOIN pages atom ON atom.id = edge.to_page_id
  LEFT JOIN pages source ON source.id = edge.from_page_id
  WHERE edge.link_source = 'atom-provenance'
    AND atom.type = 'atom'
    AND atom.deleted_at IS NULL
), identity_counts AS (
  SELECT
    atom_id,
    count(DISTINCT source_page_id)
      FILTER (WHERE endpoint_in_atom_scope) AS source_page_identity_count,
    count(DISTINCT source_page_id)
      FILTER (WHERE endpoint_in_atom_scope AND origin_deleted_at IS NULL)
      AS live_source_page_identity_count,
    count(*) FILTER (WHERE source_endpoint_missing) AS missing_endpoint_edge_count,
    count(*) FILTER (WHERE NOT source_endpoint_missing AND NOT endpoint_in_atom_scope)
      AS out_of_scope_edge_count
  FROM edge_evidence
  GROUP BY atom_id
)
SELECT
  evidence.*,
  counts.source_page_identity_count,
  counts.live_source_page_identity_count,
  counts.missing_endpoint_edge_count,
  counts.out_of_scope_edge_count,
  CASE
    WHEN evidence.source_endpoint_missing THEN 'missing_source_endpoint'
    WHEN NOT evidence.endpoint_in_atom_scope THEN 'cross_source_endpoint'
    WHEN evidence.origin_deleted_at IS NOT NULL THEN 'soft_deleted_source_endpoint'
    WHEN stored_source_slug IS DISTINCT FROM origin_slug
      THEN 'binding_edge_disagreement'
    WHEN stored_source_hash IS DISTINCT FROM current_source_hash
      THEN 'source_changed_or_hash_disagreement'
    ELSE 'binding_matches_current_source'
  END AS observation
FROM edge_evidence evidence
JOIN identity_counts counts USING (atom_id)
ORDER BY atom_source_id, atom_slug, edge_id;
```

Run an explicit endpoint-gap query; do not rely on prose or an inner join that
hides missing/soft-deleted endpoints:

```sql
SELECT
  edge.id AS edge_id,
  edge.from_page_id,
  edge.to_page_id,
  atom.id AS atom_id,
  atom.source_id AS atom_source_id,
  atom.slug AS atom_slug,
  source.id AS source_page_id,
  source.source_id AS origin_source_id,
  source.slug AS origin_slug,
  source.deleted_at AS origin_deleted_at,
  CASE
    WHEN source.id IS NULL THEN 'missing_source_endpoint'
    WHEN source.source_id IS DISTINCT FROM atom.source_id THEN 'cross_source_endpoint'
    ELSE 'soft_deleted_source_endpoint'
  END AS endpoint_state
FROM links edge
JOIN pages atom ON atom.id = edge.to_page_id
LEFT JOIN pages source ON source.id = edge.from_page_id
WHERE edge.link_source = 'atom-provenance'
  AND atom.type = 'atom'
  AND atom.deleted_at IS NULL
  AND (source.id IS NULL
       OR source.deleted_at IS NOT NULL
       OR source.source_id IS DISTINCT FROM atom.source_id)
ORDER BY atom.source_id, atom.slug, edge.id;
```

Also query atoms with no provenance edge at all, including whether the stored
locator resolves to an active, soft-deleted, or absent same-source page:

```sql
SELECT
  atom.id AS atom_id,
  atom.source_id AS atom_source_id,
  atom.slug AS atom_slug,
  atom.frontmatter->>'source_slug' AS stored_source_slug,
  atom.frontmatter->>'source_hash' AS stored_source_hash,
  source.id AS stored_source_page_id,
  source.deleted_at AS stored_source_deleted_at,
  CASE
    WHEN source.id IS NULL THEN 'stored_source_missing'
    WHEN source.deleted_at IS NOT NULL THEN 'stored_source_soft_deleted'
    ELSE 'no_provenance_edge'
  END AS gap_state
FROM pages atom
LEFT JOIN pages source
  ON source.source_id = atom.source_id
 AND source.slug = atom.frontmatter->>'source_slug'
WHERE atom.type = 'atom'
  AND atom.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM links edge
    WHERE edge.to_page_id = atom.id
      AND edge.link_source = 'atom-provenance'
  )
ORDER BY atom.source_id, atom.slug;
```

These gaps are candidates, not proof of collision: old imports, deleted
sources, corruption, and interrupted extraction can produce the same shape.

Write a JSON manifest containing:

- `manifest_version`, brain identifier, engine kind, database identity,
  source-scope ids, backup/snapshot identifier, schema version, transaction
  snapshot identifier, and the starting `page_generation_clock.value`;
- atom `(source_id, slug)`, row id, generation, content hash, full frontmatter,
  body, chunks, tags, aliases, versions, and every incident link;
- every candidate origin `(source_id, slug)`, its current content hash, and
  whether a historical version matching `stored_source_hash` is available;
- classification, evidence, proposed action, and an `approved: false` field;
- `discovery_digest_algorithm: "sha256"` and `discovery_digest`, computed as
  specified below.

Canonicalization is exact: remove the `discovery_digest` field itself, encode
the remaining object as RFC 8785 JSON Canonicalization Scheme bytes in UTF-8
(no BOM or trailing newline), then store the lowercase hexadecimal SHA-256 of
those bytes. Represent SQL `bigint`/ids/generations/counts as decimal strings;
timestamps as UTC RFC 3339 with exactly six fractional digits; byte strings as
lowercase hex; JSONB as JSON values, not JSON-encoded strings; absent nullable
columns as explicit `null`. Sort candidates by `(atom_source_id, atom_slug,
atom_id)`, origins by `(origin_source_id, origin_slug, source_page_id)`, and
all row evidence by table primary key. For links, preserve every row and every
column listed in the query above; never collapse variants before hashing.

Re-running discovery against unchanged data must reproduce the exact canonical
bytes and digest, not merely the same candidate count. The manifest remains
immutable with `approved: false`; human approval is a separate signed,
append-only record that names the manifest digest, backup id, approved actions,
and expected post-state digest. Approval never edits and re-hashes the evidence.

## Phase 2: ambiguity review

Classify each candidate independently:

- **Multiple distinct same-source identities:**
  `source_page_identity_count > 1` is high-confidence evidence that one legacy
  atom slug represented more than one source page. Multiple edge rows from one
  source identity do not satisfy this classification. The stored atom only
  proves the last surviving binding; it does not recover overwritten bodies or
  quotes.
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

1. Start a transaction and re-run the **entire source-scoped discovery**, not
   just the selected candidates. Canonicalize it and require its digest, schema
   version, source scope, database identity, backup id, and
   `page_generation_clock.value` to equal the approved manifest. Any global or
   candidate drift aborts the whole mutation phase; never skip one changed
   candidate and continue with the rest.
2. Perform additive recovery first. Re-extract approved source pages through
   the fixed runtime so each receives its collision-proof atom identity and an
   idempotent provenance edge. Do not delete or rename the legacy row yet.
3. Verify every new atom is independently addressable and has the approved
   `source_slug`, final `source_hash`, exact observed `source_quote`, chunks,
   and exactly one matching same-source provenance edge.
4. Stop for a second human checkpoint. Only then may an approved cleanup
   transaction tombstone a superseded legacy atom or remove obsolete legacy
   edges. Never hard-delete it in the first repair pass.
5. Re-run and canonicalize complete discovery. Compare the actual post-state
   with the approved expected post-state, row-for-row and digest-for-digest.
   Unexpected candidates, edge variants, endpoints, ids, generations, or row
   counts abort cleanup.

The mutation boundary should be one candidate group per database transaction.
External re-extraction cannot share that transaction, which is why additive
recovery and destructive cleanup are separate approval phases.

### Compare-and-write contract

Every future apply implementation must use exact preimages in SQL predicates,
not a read followed by a broad write:

- A page mutation predicates on `id` plus exact equality with the approved
  preimage of **every persisted page column** (including `(source_id, slug)`,
  generation, title/type/page kind, content hash, frontmatter, body/timeline,
  timestamps, and deletion state), using `IS NOT DISTINCT FROM` for nullable
  values. A schema-added column is automatically part of this comparison; an
  implementation may not use a frozen subset. It returns the complete changed
  row with `RETURNING *`; expected cardinality is exactly one, or exactly zero
  only for a manifest-declared, fully verified no-op.
- An edge mutation predicates on `id` plus the complete edge preimage:
  `from_page_id`, `to_page_id`, `link_type`, `context`, `link_source`,
  `link_kind`, `origin_page_id`, `origin_field`, `resolution_type`, and
  `created_at`. It returns the complete changed row. The returned edge-id set
  must equal the manifest's exact approved set—same ids, no extras—and the
  affected count must equal that set's cardinality.
- Additive page/edge writes require an explicit `absent` preimage. An insert
  must `RETURNING` exactly one complete row. A retry may return zero only after
  a same-transaction read proves the existing row is byte-for-byte the
  manifest's approved desired state; otherwise it is drift.
- After each candidate-group transaction, compare every per-table affected-row
  count and returned primary-key set with the approved expectation. Before the
  next group, re-check the global generation/digest expected after the prior
  group. A mismatch rolls back the open transaction and aborts the entire
  phase. Never continue after any preimage, `RETURNING`, cardinality, or global
  drift mismatch.

## Idempotency and rollback

- New page-derived atom slugs are deterministic from the complete source-page
  locator, full source content hash, and existing title components; retries of
  the same source version address the same row while changed content gets a
  different identity.
- Provenance insertion uses the existing unique edge key, so retrying produces
  exactly one matching edge.
- Every write uses the compare-and-write guards above. Desired state is a
  manifest-declared, fully verified no-op; unexpected state is a conflict,
  never an overwrite.
- Append one receipt per attempted transaction, including manifest and backup
  digests, actor/approval ids, transaction id, global generation and discovery
  digests before/after, commit/rollback outcome, and per-table expected versus
  actual affected-row counts. For every changed page, chunk, tag, alias,
  version, and edge, store the complete canonical preimage and complete
  `RETURNING` postimage—not ids alone. For additive rows, record `preimage:
  "absent"` plus the full returned row and all dependent rows. A failed/drifted
  attempt records zero committed affected rows and the exact failed guard.
  Receipts are append-only and digest-chained.
- The authoritative rollback boundary is the verified full backup. If any
  destructive cleanup committed, restore that backup into a separate location,
  validate it, and use the normal engine-specific restore procedure; do not
  improvise inverse SQL on the live primary.
