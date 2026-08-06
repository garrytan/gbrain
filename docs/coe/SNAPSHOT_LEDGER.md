# Immutable snapshot ledger

Phase 2 adds an immutable acquisition system of record for CoE Lite. Raw bytes and canonical JSON
records live in a content-addressed filesystem registry. The `coe_*` PostgreSQL and PGLite tables
are disposable projections and never contain canonical raw bytes.

## Invariants

- A raw object key is derived from the exact SHA-256 of its bytes.
- A canonical source, snapshot, lifecycle event, or journal stage is written once. Reusing its key
  with different canonical JSON fails with `id_mismatch`.
- A snapshot identity binds `source_id`, exact content hash, and media type. Identical input is
  idempotent; changed bytes create a successor instead of mutating the prior snapshot.
- HTML and PDF remain distinct representations of one logical source.
- Retraction and supersession change projection state through immutable lifecycle events. Canonical
  snapshot JSON and raw bytes are retained.
- A transport failure has outcome `failed`, an error code, and no fabricated content hash or raw
  object.
- SQL writes for a source, raw-object reference, snapshot, acquisition, redirect chain, and bundled
  lifecycle events occur in one transaction.

## Registry layout

```text
objects/sha256/ab/<64-hex>       exact raw bytes
records/sources/<source>.json   immutable source contracts
records/snapshots/<id>.json     immutable snapshot contracts
records/events/<event>.json     immutable lifecycle events
journal/<event>/000-started.json
journal/<event>/100-ready.json
journal/<event>/200-records-written.json
journal/<event>/300-*.json      terminal outcome
staging/                        bounded temporary writes only
locks/                          per-source/representation acquisition locks
```

Object and record promotion uses same-filesystem hard links after file and directory syncs. An
interruption after `100-ready` can be completed by `recoverPending()`. `rebuildProjection()` reads
the canonical acquisition journal, verifies every referenced raw hash, restores failed/rejected
attempts and redirect chains, then replays lifecycle events in causal order. Synthetic `restored`
events are used only for an orphan canonical snapshot that has no ready journal record.

### Registry trust boundary

The registry root is a trusted local boundary: it must be owned by the process user, mode `0700`,
and not writable by another principal. Initialization rejects a symlinked, foreign-owned, or
group/world-accessible root. Managed parent and final components are checked with `lstat`, and final
files are opened with no-follow semantics where the runtime supports them.

These checks prevent accidental traversal and persistent symlink substitution under that contract;
they are not a kernel-level defense against an active local process that can mutate the registry
concurrently. Node/Bun does not expose the `openat2`/directory-FD primitives needed to prove that
stronger guarantee. Deployments requiring protection from such a principal must isolate the
registry by OS permissions/container boundary or use a native `openat2` helper or external object
store.

## Bounded HTTP acquisition

`BoundedHttpClient` is GET-only and fail-closed:

- HTTPS and exact host allowlist only;
- no URI credentials, sensitive query parameters, or non-default ports;
- every redirect is handled manually, revalidated, and capped;
- DNS answers containing loopback, private, link-local, documentation, multicast, or reserved
  addresses are rejected;
- response timeout plus advertised and streamed byte limits;
- raw response media type is recorded, while disagreement with the manifest expectation causes
  quarantine;
- errors become stable machine codes without response bodies or exception text in the journal.

DNS is resolved once per hop. Every returned address must be public, then the production
`node:https` transport pins the socket lookup to the validated address while retaining the original
hostname for `Host` and TLS SNI. Redirects repeat allowlist, DNS validation, and pinning before the
next request.

## SQL projection

Migration 67 adds:

- `coe_sources`
- `coe_raw_objects`
- `coe_snapshots`
- `coe_acquisitions`
- `coe_acquisition_redirects`
- `coe_snapshot_events`

Foreign keys use `ON DELETE RESTRICT`; composite constraints bind acquisition source IDs to their
snapshot source IDs, and object keys are constrained to the path derived from their SHA-256.
PostgreSQL migrations enable RLS unconditionally and verify `relrowsecurity` on all ten CoE tables
before advancing the schema version. PGLite applies the same data constraints without RLS. The same
projection implementation uses the shared `BrainEngine` transaction/parameter contract on both
engines.

## ScientistOne pilot

The checked manifest is
[`fixtures/coe/pilot/science-one-coe/manifest.json`](../../fixtures/coe/pilot/science-one-coe/manifest.json).
Its required set is deliberately small:

- versioned arXiv HTML and PDF for `2605.26340v1`;
- the project page linked by arXiv;
- the commit-addressed Git tree for the generated-artifacts repository linked by the project page;
- one local architecture note explicitly classified `derived_internal`.

Exact-title discovery did not expose a directly verifiable ScientistOne blog or publication page on
`research.google` on 2026-08-04. Those candidates are omitted rather than guessed. Secondary
summaries are not pilot evidence.

Validate without network or registry writes:

```bash
bun run coe:pilot --validate-only
```

Acquire into an isolated canonical registry and PGLite projection:

```bash
bun run coe:pilot \
  --registry-root /root/brain/coe/science-one-coe/stable-v1/registry \
  --database-path /root/brain/coe/science-one-coe/stable-v1/projection.pglite \
  --report /root/audit-artifacts/coe-lite-gbrain-phase2/pilot-report.json
```

The command processes all entries even after a bounded source failure, writes an atomic report, and
returns exit code 2 unless every required entry is `active` and either newly promoted or deduplicated.

## G2 gate: `SNAPSHOT_LEDGER_READY`

The gate passes only when:

1. every required pilot entry has an active, hash-verifiable canonical snapshot;
2. duplicate acquisition creates no second logical snapshot;
3. changed content creates an immutable successor;
4. hash mismatch rejects before raw promotion;
5. empty or MIME-incoherent content is quarantined;
6. interrupted writes recover without a partial projection;
7. a fresh projection rebuild restores acquisitions, redirects, failures, supersessions, and
   retractions from canonical artifacts;
8. the targeted PGLite and PostgreSQL tests pass.
