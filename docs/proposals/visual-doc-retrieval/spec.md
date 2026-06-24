# Feature Specification: Faithful Retrieval over Visually-Rich Documents

**Feature Branch**: `001-visual-doc-retrieval`

**Created**: 2026-06-19

**Status**: Draft

**Input**: User description: "Implement the pipeline for ingesting visually-rich documents (PDFs with tables, figures, charts) into a searchable knowledge base, so queries retrieve the correct content and answers stay faithful to the source — including the visual/tabular content that plain text extraction loses."

<!-- This spec is WHAT/WHY only. Implementation choices (multimodal embedding, vision transcription, layout detection, reranking, specific providers) are deliberately deferred to plan.md — see Assumptions. -->

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ingest a document without losing its tables and figures (Priority: P1)

A user adds a PDF that carries meaning in its layout — tables of numbers, charts, figures — to the knowledge base, and that visual content survives ingestion intact (not flattened to garbled or missing text).

**Why this priority**: This is the system's entire reason to exist. Plain text extraction silently corrupts dense tables and drops figures; if ingestion isn't faithful, nothing downstream can be. A working version of just this story already delivers value: a trustworthy store of visual documents.

**Independent Test**: Ingest a PDF containing a dense numeric table; confirm the table's values are present and uncorrupted when the unit is retrieved.

**Acceptance Scenarios**:

1. **Given** a PDF with a numeric table whose cells include sub-columns, **When** it is ingested and the table is later retrieved, **Then** the cell values are intact (sub-columns preserved, not merged into a single garbled number).
2. **Given** a PDF page containing a figure or chart, **When** it is ingested, **Then** the figure's content is retained and retrievable (not silently dropped).
3. **Given** a multi-page PDF, **When** it is ingested, **Then** every page's content is represented — none lost to length limits.

---

### User Story 2 - Retrieve the correct unit for a query (Priority: P2)

A user asks a question, and the system returns the specific document region that answers it — distinguishing the right table/section from sibling regions and from unrelated pages.

**Why this priority**: Faithful storage is worthless if retrieval surfaces the wrong region. Precision (right unit, not just right document) is what makes the store usable.

**Independent Test**: Index a document with two tables on one page; issue two targeted queries; each returns its own table as the top result.

**Acceptance Scenarios**:

1. **Given** a document with multiple sibling tables, **When** a user queries content specific to one of them, **Then** that table is the top-ranked result, clearly separated from the others.
2. **Given** a long document, **When** a user queries content located on a late page, **Then** that content is retrieved at parity with early-page content.
3. **Given** a query whose words differ from the source wording (paraphrase/synonyms), **When** retrieval runs, **Then** the semantically matching unit is still returned.

---

### User Story 3 - Get a faithful, sourced answer (Priority: P3)

A user asks for a specific fact (e.g., a value from a table); the system returns an answer that matches the source exactly and cites where it came from.

**Why this priority**: The end deliverable. It depends on P1 (faithful content) and P2 (right unit), so it ranks below them, but it's what the user ultimately consumes.

**Independent Test**: Ask a question whose answer is a specific table value; verify the returned value equals the source and the answer cites the page/region.

**Acceptance Scenarios**:

1. **Given** a retrieved unit, **When** the user asks for a specific value in it, **Then** the answer equals the source value and includes provenance (document, page, region).
2. **Given** a question with no supporting content in the corpus, **When** the user asks it, **Then** the system reports "no relevant content found" rather than fabricating an answer.

---

### User Story 4 - Reproducible, cost-bounded ingestion (Priority: P3)

An operator re-ingests documents and runs queries with predictable, bounded cost and no duplication or silent drift.

**Why this priority**: Operability. Not user-facing value per se, but required for trust at scale and for repeatable results.

**Independent Test**: Ingest the same unchanged document twice; confirm no duplicate units; confirm reported cost is within the configured budget.

**Acceptance Scenarios**:

1. **Given** an unchanged document, **When** it is ingested a second time, **Then** no duplicate units are created.
2. **Given** a configured per-document/per-query budget, **When** ingestion or a query runs, **Then** cost stays within budget and the actual cost is reported.

---

### Edge Cases

- **Scanned / image-only PDF** (no machine-readable text layer) — must still be ingested and made retrievable.
- **Table or figure spanning a page break** — must be reassembled into one unit, not split into two useless halves.
- **Multi-column layout / non-linear reading order** — units and reading order must be correct, not column-fused.
- **A single region larger than the processing size limit** — must be handled (sub-split or flagged), never silently truncated.
- **Corrupt, encrypted, or password-protected PDF** — must fail explicitly with a clear error, not partially ingest.
- **Layout segmentation low-confidence or failed** — must fall back to a safe chunking strategy and flag the document, never hard-fail.
- **Query about absent content** — must return "not found," not a confident hallucination.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST ingest documents whose meaning lives in visual layout (tables, figures, charts) and preserve that content for retrieval.
- **FR-002**: System MUST segment each document into **semantically coherent units** (a table, a figure with its caption, a section) rather than fixed-size or arbitrary geometric splits.
- **FR-003**: System MUST preserve dense tabular/numeric content without value corruption (no merged or garbled cells).
- **FR-004**: System MUST NOT silently drop or truncate any portion of a document during ingestion; unprocessable content MUST be flagged, not dropped.
- **FR-005**: System MUST retrieve the correct semantic unit for a query, distinguishing it from sibling units within the same document.
- **FR-006**: System MUST allow querying the full extent of a document regardless of its length (no late-content loss).
- **FR-007**: System MUST support queries that are semantic (paraphrase/synonym), not only literal keyword matches.
- **FR-008**: System MUST return answers that faithfully match the source content and include provenance (document, page, region).
- **FR-009**: System MUST record the source location (page + region) for every retrievable unit.
- **FR-010**: System MUST ingest documents lacking a machine-readable text layer (scanned / image-only).
- **FR-011**: System MUST degrade gracefully when automated layout segmentation is low-confidence or fails — fall back to a safe chunking strategy and flag the document; never hard-fail ingestion.
- **FR-012**: Ingestion MUST be idempotent — re-ingesting unchanged content MUST NOT create duplicate units.
- **FR-013**: System MUST keep retrieval results reproducible for a fixed configuration. [NEEDS CLARIFICATION: tolerance/behavior when an underlying model version changes — re-index automatically, warn, or pin?]
- **FR-014**: System MUST distinguish "no relevant content found" from a confident answer (no fabrication when the corpus lacks the information).
- **FR-015**: System SHOULD allow an operator to bound per-document and per-query cost and MUST report actual cost incurred.
- **FR-016**: Reassembly MUST stitch a unit that spans a page boundary (e.g., a continued table) into a single retrievable unit.

### Key Entities *(include if feature involves data)*

- **Document**: a source file. Attributes: id, source/URI, page count, content hash (for idempotency), ingestion status.
- **Semantic Unit (Chunk)**: a coherent region of a document. Attributes: type (table/figure/chart/text/caption/section), page(s), bounding region, reading order, provenance, confidence, link to its embedding.
- **Embedding**: the searchable representation of a unit (modality-aware: visual or textual).
- **Query**: a user information need (text, possibly multimodal).
- **Retrieval Result**: a ranked set of units with relevance scores and provenance.
- **Answer**: a response grounded in retrieved unit(s), with citations to the source region(s).

## Success Criteria *(mandatory)*

<!-- Targets grounded in the empirical study in /workspaces/random/gbrain-testing/COMPARISON.md -->

### Measurable Outcomes

- **SC-001**: On a benchmark of dense tables, retrieved/read table values contain **zero cell-merge/garble errors** (baseline failure observed: a "55.2/66.1" cell flattened to "55.266.1"; target: 0 such errors).
- **SC-002**: For documents with multiple sibling tables, a targeted query returns the **correct unit as the #1 result in ≥95%** of cases.
- **SC-003**: **100% of a document's content is retrievable** — late-page content (e.g., a final-page table) retrieves at parity with early-page content (baseline failure: whole-document single-vector silently dropped ~32% of pages including the last; target: no loss).
- **SC-004**: **≥99% of answered queries include correct provenance** (document, page, region) that a reviewer can verify against the source.
- **SC-005**: Re-ingesting an unchanged document creates **0 duplicate units**.
- **SC-006**: For queries with no supporting content, the system returns an explicit "not found" in **≥95%** of such cases (no fabricated answer).
- **SC-007**: Per-document ingestion cost and per-query cost stay **within the configured budget**, and actual cost is reported for every run.
- **SC-008**: A query phrased with no lexical overlap with the source still retrieves the correct unit (semantic match), measured as **≥90% recall@3** on a paraphrase benchmark.

## Assumptions

- Target "users" are developers (or an automated agent) building a searchable knowledge base over their own document corpus; this is infrastructure, not an end-user app.
- Documents in scope for v1 are **PDFs** (papers, reports, slides, scanned docs). [NEEDS CLARIFICATION: which non-PDF formats, if any, are in scope — DOCX/XLSX/HTML?]
- Scale for v1 is **personal-to-moderate** (≤ low-thousands of documents); large-scale sharding/multi-tenant is out of scope. [NEEDS CLARIFICATION: target corpus size]
- A vector/semantic store and a vision-capable model are available; **specific providers and architecture (embedding model, vision model, reranker, layout detector) are HOW and are deferred to `plan.md`.**
- Network access to hosted models is assumed; fully-offline operation is out of scope for v1. [NEEDS CLARIFICATION: is on-prem/offline a requirement?]
- The system may reuse an existing knowledge-store/persistence layer rather than introducing a new one. [NEEDS CLARIFICATION: reuse the existing brain store, or stand up a dedicated one?]
- "Faithful" is judged against the source PDF as ground truth; human-reviewable provenance is the verification mechanism.
