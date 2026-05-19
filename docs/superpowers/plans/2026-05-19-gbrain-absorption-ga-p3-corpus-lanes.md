# GBrain Absorption GA-P3 Corpus Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `GA-P3` roadmap slice as post-scope corpus-lane provenance metadata for imports, retrieval citations, and retrieval traces.

**Architecture:** Corpus lanes are not scopes, authorities, or new storage roots. The lane resolver runs only after the Scope Gate and decorates existing selectors, canonical reads, manifest/section source refs, and trace source refs using existing page frontmatter and import origins. This slice intentionally avoids new database tables and does not allow lane metadata to authorize reads or writes.

**Tech Stack:** TypeScript, Bun tests, existing SQLite-capable service tests, existing `retrieve_context` / `read_context` / import pipeline.

---

## Files

- Create: `src/core/services/corpus-lane-service.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/services/note-manifest-service.ts`
- Modify: `src/core/services/note-section-service.ts`
- Modify: `src/core/services/retrieval-selector-service.ts`
- Modify: `src/core/services/retrieve-context-service.ts`
- Modify: `src/core/services/read-context-service.ts`
- Modify: `src/core/services/memory-writeback-router-service.ts`
- Modify: `src/core/operations.ts`
- Test: `test/corpus-lane-service.test.ts`
- Test: `test/import-file.test.ts`
- Test: `test/read-context-service.test.ts`
- Test: `test/retrieval-context-operations.test.ts`
- Test: `test/memory-writeback-router-service.test.ts`
- Create: `test/fixtures/gbrain-absorption/ga-p3-corpus-lanes.fixture.json`
- Create: `test/scenarios/s29-gbrain-corpus-lanes.test.ts`
- Modify: `test/scenarios/README.md`
- Modify: `test/gbrain-absorption-docs-contract.test.ts`
- Modify: `docs/architecture/redesign/05-workstream-context-map.md`
- Modify: `docs/architecture/redesign/07-workstream-profile-memory-and-scope.md`
- Modify: `docs/architecture/redesign/08-evaluation-and-acceptance.md`
- Modify: `docs/MBRAIN_VERIFY.md`

## Task 1: Add Corpus Lane Metadata Helpers

**Files:**
- Create: `src/core/services/corpus-lane-service.ts`
- Modify: `src/core/types.ts`
- Test: `test/corpus-lane-service.test.ts`

- [ ] **Step 1: Define optional lane types**

Add these shapes to `src/core/types.ts` near retrieval selector types:

```ts
export type CorpusLaneArtifactKind =
  | 'note'
  | 'worktree'
  | 'transcript'
  | 'import'
  | 'source_record'
  | 'derived';

export interface CorpusLaneMetadata {
  lane_id: string;
  source_record?: string;
  import_origin?: string;
  artifact_kind?: CorpusLaneArtifactKind;
}
```

Thread `corpus_lane?: CorpusLaneMetadata` into `RetrievalSelector`, `RetrievalCanonicalTarget`, `RetrievalMatchedChunk`, `CanonicalContextRead`, and `RetrievalTraceInput`.

- [ ] **Step 2: Implement helper functions**

Create `src/core/services/corpus-lane-service.ts` with:

```ts
import type { CorpusLaneMetadata } from '../types.ts';

export function extractCorpusLaneMetadata(
  frontmatter: Record<string, unknown> | undefined,
  fallbackImportOrigin?: string,
): CorpusLaneMetadata | undefined;

export function corpusLaneSourceRefs(lane: CorpusLaneMetadata | undefined): string[];

export function extractFrontmatterSourceRefs(
  frontmatter: Record<string, unknown> | undefined,
  fallbackImportOrigin?: string,
): string[];

export function corpusLaneFromSourceRefs(sourceRefs: string[]): CorpusLaneMetadata | undefined;

export function mergeSourceRefs(...groups: Array<readonly string[] | undefined>): string[];
```

Rules:
- Accept `corpus_lane`, `corpus_lane_id`, or `lane_id` as the lane id.
- Accept `source_record` or `source_record_id`.
- Accept `import_origin`; otherwise use the import path fallback only when a lane is explicitly present.
- Accept `artifact_kind`.
- Accept `source_refs` as string or string array.
- Return citation refs as `corpus_lane:<lane_id>`, `source_record:<source_record>`, and `import_origin:<import_origin>`.
- Do not invent a lane id when frontmatter has no explicit lane.

- [ ] **Step 3: Add helper tests**

Add `test/corpus-lane-service.test.ts` covering:
- explicit frontmatter lane produces normalized metadata and citation refs
- string and array `source_refs` are preserved
- fallback import origin is used only when lane metadata is explicit
- no explicit lane returns no lane metadata
- source refs can reconstruct lane metadata

## Task 2: Preserve Lane Provenance Through Import Projections

**Files:**
- Modify: `src/core/services/note-manifest-service.ts`
- Modify: `src/core/services/note-section-service.ts`
- Test: `test/import-file.test.ts`

- [ ] **Step 1: Include frontmatter provenance in manifest source refs**

In `buildNoteManifestEntry`, merge body `[Source: ...]` refs with `extractFrontmatterSourceRefs(page.frontmatter, path)`.

- [ ] **Step 2: Include page-level lane provenance in section source refs**

In `buildNoteSectionEntries`, merge section body refs with page-level frontmatter lane/source refs. This keeps narrow section reads citation-complete even when the section body lacks a source marker.

- [ ] **Step 3: Test import projection**

Extend `test/import-file.test.ts` with a markdown fixture:

```yaml
---
title: Imported Transcript
type: source
corpus_lane: transcripts
source_record: source-record:meeting-42
import_origin: imports/meeting-42.md
artifact_kind: transcript
source_refs:
  - Source: imported transcript, 2026-05-19
---
```

Assert the stored manifest and at least one section include `corpus_lane:transcripts`, `source_record:source-record:meeting-42`, `import_origin:imports/meeting-42.md`, and the explicit source ref.

## Task 3: Thread Lane Metadata Through Retrieval And Read Context

**Files:**
- Modify: `src/core/services/retrieval-selector-service.ts`
- Modify: `src/core/services/retrieve-context-service.ts`
- Modify: `src/core/services/read-context-service.ts`
- Modify: `src/core/operations.ts`
- Test: `test/read-context-service.test.ts`
- Test: `test/retrieval-context-operations.test.ts`

- [ ] **Step 1: Preserve selector lane metadata**

Update selector normalization and operation selector validation so `corpus_lane` is allowed as an object with string fields.

Do not add lane metadata to `retrievalSelectorId`; a lane is provenance metadata in this slice and must not churn selector identity.

- [ ] **Step 2: Decorate retrieve_context candidates after scope gate**

After scope gate allow, derive lane metadata from section/page source refs and attach it to `read_selector`, `canonical_target`, and `matched_chunks` when available.

Persist retrieve traces with lane/source refs in `source_refs` in addition to selector ids. Add verification entries such as `corpus_lane:<lane_id>:post_scope_metadata`.

- [ ] **Step 3: Decorate read_context reads and citations**

Canonical reads should include `corpus_lane` when source refs contain lane metadata. Source refs must include frontmatter lane refs even when text contains body `[Source: ...]` markers.

Persist read traces with canonical selector ids plus lane/source refs.

- [ ] **Step 4: Test read and operation surfaces**

Extend read-context tests to assert:
- a section read with lane frontmatter returns `authority: canonical_compiled_truth`
- `canonical_reads[0].corpus_lane.lane_id` is set
- source refs include lane, source record, and import origin
- persisted trace includes selector id and lane/source refs

Extend operation tests to assert selector parsing accepts `corpus_lane` and rejects non-object/non-string lane fields.

## Task 4: Fail Ambiguous Imported Writes Instead Of Picking A Lane

**Files:**
- Modify: `src/core/services/memory-writeback-router-service.ts`
- Modify: `src/core/operations.ts`
- Test: `test/memory-writeback-router-service.test.ts`

- [ ] **Step 1: Add imported-source lane guard**

For `routeMemoryWriteback`, when `source_kind === 'import'` and `evidence_kind === 'source_extracted'`, require either:
- a `corpus_lane` input with `lane_id`, or
- a source ref with `corpus_lane:`, `source_record:`, or `import_origin:`.

If absent, return `decision: 'defer'`, `intended_operation: 'none'`, reason `import_lane_required`, and missing requirement `corpus_lane`.

- [ ] **Step 2: Parse operation lane input**

Allow `route_memory_writeback` to receive a `corpus_lane` object with string fields. Do not let it affect `scope_id`, `sensitivity`, target selection, or canonical write permission.

- [ ] **Step 3: Add router tests**

Test that imported source-extracted writeback without lane provenance defers, while the same request with `corpus_lane:imports` or `source_record:...` proceeds through the existing candidate/canonical path.

## Task 5: Add GA-P3 Scenario, Fixture, And Docs

**Files:**
- Create: `test/fixtures/gbrain-absorption/ga-p3-corpus-lanes.fixture.json`
- Create: `test/scenarios/s29-gbrain-corpus-lanes.test.ts`
- Modify: `test/scenarios/README.md`
- Modify: `test/gbrain-absorption-docs-contract.test.ts`
- Modify: `docs/architecture/redesign/05-workstream-context-map.md`
- Modify: `docs/architecture/redesign/07-workstream-profile-memory-and-scope.md`
- Modify: `docs/architecture/redesign/08-evaluation-and-acceptance.md`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Add GA-P3 fixture**

Fixture must include:
- `stage_id: "GA-P3"`
- lane cases for `notes`, `worktree`, `transcripts`, `imports`, and `derived`
- `lane_grants_authority: false` for every case
- required preservation fields: `scope_gate`, `source_record`, `import_origin`, `retrieval_trace`, `canonical_selector`

- [ ] **Step 2: Add S29 scenario**

S29 should replay:
- import lane metadata reaches manifest/section
- retrieve_context explains the lane without bypassing scope gate
- read_context returns canonical evidence plus lane-aware citations
- route_memory_writeback defers ambiguous imported writes
- fixture and README registration are present

- [ ] **Step 3: Update docs and verification runbook**

Add a concise GA-P3 section to docs and `docs/MBRAIN_VERIFY.md` with focused commands:

```bash
bun test test/corpus-lane-service.test.ts test/import-file.test.ts test/read-context-service.test.ts test/retrieval-context-operations.test.ts test/memory-writeback-router-service.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s29-gbrain-corpus-lanes.test.ts
bun run test:scenarios
bunx tsc --noEmit --pretty false
```

## Verification

Run focused checks first:

```bash
source ~/.zshrc 2>/dev/null || true
bun test test/corpus-lane-service.test.ts test/import-file.test.ts test/read-context-service.test.ts test/retrieval-context-operations.test.ts test/memory-writeback-router-service.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s29-gbrain-corpus-lanes.test.ts
bun run test:scenarios
bunx tsc --noEmit --pretty false
```

Before PR merge, run:

```bash
source ~/.zshrc 2>/dev/null || true
bun run test
```

Then run the Docker-backed E2E lifecycle from `AGENTS.md`.
