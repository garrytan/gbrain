# Canonical evidence ledger

Phase 3 turns an immutable Phase 2 snapshot into a versioned normalized document and citable
EvidenceItems. Canonical normalized bytes and one immutable JSON bundle live in the same
content-addressed registry as raw snapshots. PostgreSQL and PGLite remain rebuildable projections.

## Boundary and invariants

- Normalized text is NFC UTF-8 with LF line endings. Spans are half-open UTF-8 byte offsets, never
  JavaScript character indexes.
- A normalized document has one root section covering all bytes. Every other section has one
  earlier, less-deep parent; ordinals are contiguous, which prevents forests and cycles.
- Every EvidenceItem span is contained by its declared section and resolves to exactly one raw
  mapping. Every mapping has exactly one EvidenceItem. Invalid UTF-8 boundaries, missing mappings,
  ambiguous mappings, wrong sections, and orphan mappings fail before projection.
- `text_hash`, section hashes, normalized object hashes, document IDs, and EvidenceItem IDs are
  recalculated on every verified read or rebuild.
- The normalizer name, version, and configuration hash are part of normalized-document identity.
  Output drift under an unchanged descriptor fails with `id_mismatch`; changing the descriptor
  creates another immutable normalized document.
- Retrieval chunks are not accepted by the compiler and do not participate in any canonical ID.
  Retuning a chunker therefore leaves EvidenceItems unchanged.
- Scope propagates from snapshot to document to evidence without widening. Canonical reads apply
  brain, source, visibility, owner, and named-reader checks before returning an EvidenceItem.

## Normalizers

| Input | Canonical units | Raw locator | Runtime identity |
| --- | --- | --- | --- |
| Markdown / plain text | headings, paragraphs, lists, quotes, fenced code, pipe-table cells | line range or table cell | `coe-markdown-lines@1.0.0` |
| JSON | canonical scalar or empty-container leaves | JSON-pointer block ID | `coe-json-pointers@1.0.0` |
| HTML | semantic text blocks, table cells, code, captions, image alternatives | parser block ID | Python minor version plus bridge version |
| PDF | ordered text blocks | page and optional bounding box | exact PyMuPDF version plus bridge version |

The HTML/PDF bridge is local-only. It invokes Python with an explicit argument vector, a minimal
environment, a private temporary input, a 32 MiB input cap, a 64 MiB output cap, a 500-page / 50,000
block parser cap, and a 60-second timeout. The pilot preflight records the exact Python, HTML parser,
and PyMuPDF versions. It does not download packages or contact a network.

PDF reading order remains parser-derived. Images without verified semantics, OCR-required pages,
table-detection failures, and detected-but-unstructured tables produce blocking warnings. HTML
images without textual alternatives do the same. Such warnings do not fabricate evidence; later
claim/release gates must exclude the affected visual or tabular assertion until reviewed.

Parsing untrusted PDF bytes still crosses a native-library boundary on the host. The official pilot
is host-allowlisted and size-bounded; process/container isolation is residual hardening for broader
untrusted ingestion.

## Registry and projection

```text
objects/sha256/ab/<64-hex>                raw or normalized bytes
records/normalizations/<ndoc-id>.json     document plus all EvidenceItems
locks/<hash>.lock                         per snapshot/normalizer serialization
```

Bundle publication is write-once. The normalized object may exist unreferenced after an interruption,
but no partial canonical bundle is visible. `rebuildProjection()` verifies every referenced byte,
span, hash, scope, and ID before replaying the bundle.

Migration 68 projects the bundle into:

- `coe_normalized_documents`
- `coe_document_sections`
- `coe_normalized_mappings`
- `coe_evidence_items`

Projection uses one transaction and rejects missing parents, non-canonical conflicts, or extra child
rows. Foreign keys use `ON DELETE RESTRICT`; PostgreSQL enables RLS fail-closed when permitted.

## ScientistOne pilot

Preflight without registry or database writes:

```bash
bun run coe:evidence-pilot \
  --snapshot-report /path/to/phase2-report.json \
  --validate-only
```

Normalize the stable Phase 2 registry:

```bash
bun run coe:evidence-pilot \
  --snapshot-report /path/to/phase2-report.json \
  --registry-root /root/brain/coe/science-one-coe/stable-v1/registry \
  --database-path /root/brain/coe/science-one-coe/stable-v1/projection.pglite \
  --report /path/to/evidence-pilot.json \
  --review-sample /path/to/mapping-review-sample.json
```

The command fully re-normalizes every raw snapshot for verification, continues after a per-entry
failure, writes report files atomically, and exits 2 if any required entry fails. Blocking parser
warnings are counted per document and remain visible to later gates.

The review sample contains deterministic first/middle/last items for every pilot entry. Preserve the
pending sample as an audit artifact and copy it to a separate decision file. A human must compare
the raw excerpt and locator to normalized text in that copy, set every decision, and record their
principal and timestamp. The immutable sample fields are anchored by a SHA-256 in the pilot report:

```bash
bun run check:coe-mapping-review \
  --review-sample /path/to/mapping-review-decision.json \
  --report /path/to/evidence-pilot.json
```

The checker exits 2 for pending/rejected samples or an incomplete pilot, and fails if immutable
sample content differs from the report anchor.

## G3 gate: `EVIDENCE_LEDGER_READY`

G3 passes only when:

1. all required snapshots normalize successfully under recorded parser versions;
2. every EvidenceItem has a valid section, UTF-8 span, text hash, and unique raw mapping;
3. every mapping has exactly one EvidenceItem and projection rebuild reports no orphan;
4. a repeated run returns the same document/evidence identities and `duplicate` outcomes;
5. changing a chunker changes no EvidenceItem, while changing a normalizer descriptor creates a new
   normalized document;
6. malformed offsets, wrong-section spans, parser drift, scope widening, and unauthorized reads fail
   closed;
7. unparsed visual/table content is explicitly blocked; and
8. the hash-anchored human raw-to-normalized review sample is approved.

Machine verification alone cannot satisfy item 8 and must report `REVIEW_REQUIRED`, not G3 PASS.
