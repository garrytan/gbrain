import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  canonicalizeJson,
  makeCoeId,
  sha256Bytes,
  type SourceContract,
} from "../src/coe/contracts/index.ts";
import {
  CoeEvidenceLedger,
  InMemoryCoeEvidenceProjection,
  MarkdownDocumentNormalizer,
  SqlCoeEvidenceProjection,
  createEvidenceItem,
  type CanonicalEvidenceBundle,
  type DocumentNormalizer,
} from "../src/coe/evidence/index.ts";
import {
  CoeSnapshotLedger,
  InMemoryCoeSnapshotProjection,
  SqlCoeSnapshotProjection,
} from "../src/coe/registry/index.ts";
import { chunkText } from "../src/core/chunkers/recursive.ts";
import { PGLiteEngine } from "../src/core/pglite-engine.ts";

const FIXED_TIME = "2026-08-04T19:00:00.000Z";

function exampleSource(): SourceContract {
  const sourceId = makeCoeId("src", {
    canonical_uri: "https://example.invalid/evidence",
    source_kind: "report",
  });
  return {
    schema_version: "1.0.0",
    source_id: sourceId,
    source_kind: "report",
    title: "Evidence fixture",
    canonical_uri: "https://example.invalid/evidence",
    authors: [],
    language: "en",
    external_identifiers: [],
    scope: {
      brain_id: "science-one-coe",
      visibility: "private",
      owner_principal: "principal-owner",
      reader_principals: ["principal-reader"],
      source_ids: [sourceId],
    },
    created_at: FIXED_TIME,
    created_by: { actor_type: "system", actor_id: "coe-evidence-test" },
  };
}

function fixtureNormalizer(version = "1.0.0", paragraph = "Alpha fact."): DocumentNormalizer {
  return {
    descriptor: {
      name: "fixture-block-normalizer",
      version,
      config_hash: sha256Bytes(canonicalizeJson({ fixture: "g3", version })),
    },
    supports: (mediaType) => mediaType === "text/plain",
    normalize: async () => ({
      blocks: [
        {
          block_id: "fixture-heading",
          kind: "heading",
          text: "Overview",
          raw_text: "# Overview",
          heading_level: 1,
          raw_locator: { kind: "line_range", start_line: 1, end_line: 1 },
        },
        {
          block_id: "fixture-alpha",
          kind: "paragraph",
          text: paragraph,
          raw_text: paragraph,
          raw_locator: { kind: "line_range", start_line: 2, end_line: 2 },
        },
        {
          block_id: "fixture-beta",
          kind: "paragraph",
          text: "Beta fact.",
          raw_text: "Beta fact.",
          raw_locator: { kind: "line_range", start_line: 3, end_line: 3 },
        },
      ],
      warnings: [],
    }),
  };
}

describe("CoE normalized-document and evidence ledger", () => {
  let root: string;
  let snapshotProjection: InMemoryCoeSnapshotProjection;
  let snapshotLedger: CoeSnapshotLedger;
  let evidenceProjection: InMemoryCoeEvidenceProjection;
  let evidenceLedger: CoeEvidenceLedger;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gbrain-coe-evidence-"));
    snapshotProjection = new InMemoryCoeSnapshotProjection();
    snapshotLedger = new CoeSnapshotLedger({
      root,
      projection: snapshotProjection,
      clock: () => new Date(FIXED_TIME),
      nonce: () => crypto.randomUUID(),
    });
    evidenceProjection = new InMemoryCoeEvidenceProjection();
    evidenceLedger = new CoeEvidenceLedger({
      root,
      snapshotLedger,
      projection: evidenceProjection,
      clock: () => new Date(FIXED_TIME),
      nonce: () => crypto.randomUUID(),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function acquireText(content = "# Overview\nAlpha fact.\nBeta fact.\n", mediaType = "text/plain") {
    return snapshotLedger.acquire({
      source: exampleSource(),
      content,
      requested_uri: "https://example.invalid/evidence",
      final_uri: "https://example.invalid/evidence",
      media_type: mediaType,
      acquisition_method: "http",
      acquired_at: FIXED_TIME,
    });
  }

  test("publishes one immutable bundle and deduplicates identical normalization", async () => {
    const snapshot = await acquireText();
    const normalizer = fixtureNormalizer();

    const first = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, normalizer);
    const second = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, normalizer);

    expect(first.outcome).toBe("promoted");
    expect(second.outcome).toBe("duplicate");
    expect(second.normalized_document.normalized_document_id).toBe(first.normalized_document.normalized_document_id);
    expect(second.evidence_items.map(({ evidence_id }) => evidence_id)).toEqual(
      first.evidence_items.map(({ evidence_id }) => evidence_id),
    );
    expect(evidenceProjection.documents.size).toBe(1);
    expect(evidenceProjection.evidence.size).toBe(3);

    const verification = await evidenceLedger.verifyBundle(
      first.normalized_document.normalized_document_id,
      normalizer,
    );
    expect(verification).toEqual({
      normalized_document_id: first.normalized_document.normalized_document_id,
      evidence_items: 3,
      mappings: 3,
      sections: 4,
      raw_mapping_verified: true,
    });
  });

  test("a normalizer version change creates a new immutable normalized document", async () => {
    const snapshot = await acquireText();
    const first = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, fixtureNormalizer("1.0.0"));
    const second = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, fixtureNormalizer("2.0.0"));

    expect(second.outcome).toBe("promoted");
    expect(second.normalized_document.normalized_document_id).not.toBe(first.normalized_document.normalized_document_id);
    expect(evidenceProjection.documents.size).toBe(2);
  });

  test("evidence identities remain unchanged when retrieval chunking changes", async () => {
    const snapshot = await acquireText();
    const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, fixtureNormalizer());
    const text = await evidenceLedger.readNormalizedText(result.normalized_document.normalized_document_id);
    const idsBefore = result.evidence_items.map(({ evidence_id }) => evidence_id);

    expect(chunkText(text, { maxChars: 12 }).length).not.toBe(chunkText(text, { maxChars: 80 }).length);
    evidenceProjection.clear();
    await evidenceLedger.rebuildProjection();

    expect([...evidenceProjection.evidence.keys()].sort()).toEqual([...idsBefore].sort());
  });

  test("rejects invalid UTF-8 spans and spans assigned to another section", async () => {
    const snapshot = await acquireText("évidence fixture");
    const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, fixtureNormalizer());
    const bytes = Buffer.from(await evidenceLedger.readNormalizedText(result.normalized_document.normalized_document_id));
    const [firstEvidence, secondEvidence] = result.evidence_items.slice(1);

    expect(() => createEvidenceItem({
      document: result.normalized_document,
      normalized_bytes: bytes,
      section_id: secondEvidence!.section_id,
      normalized_span: firstEvidence!.normalized_span,
      evidence_type: "quote",
      created_at: FIXED_TIME,
    })).toThrow("outside its declared section");

    expect(() => createEvidenceItem({
      document: result.normalized_document,
      normalized_bytes: Buffer.from("é", "utf8"),
      section_id: result.normalized_document.sections[0]!.section_id,
      normalized_span: { start: 0, end: 1 },
      evidence_type: "quote",
      created_at: FIXED_TIME,
    })).toThrow("UTF-8 boundary");
  });

  test("detects normalized-object corruption on every verified read", async () => {
    const snapshot = await acquireText();
    const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, fixtureNormalizer());
    await writeFile(join(root, result.normalized_document.object_key), "tampered normalized bytes", { mode: 0o600 });

    await expect(evidenceLedger.readNormalizedText(result.normalized_document.normalized_document_id))
      .rejects.toThrow("expected sha256:");
  });

  test("never returns private evidence outside its principal and source scope", async () => {
    const snapshot = await acquireText();
    const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, fixtureNormalizer());
    const evidenceId = result.evidence_items[0]!.evidence_id;
    const sourceId = exampleSource().source_id;

    expect(await evidenceLedger.getEvidenceForContext(evidenceId, {
      brain_id: "science-one-coe",
      principal_id: "principal-reader",
      source_ids: [sourceId],
    })).not.toBeNull();
    expect(await evidenceLedger.getEvidenceForContext(evidenceId, {
      brain_id: "science-one-coe",
      principal_id: "principal-stranger",
      source_ids: [sourceId],
    })).toBeNull();
    expect(await evidenceLedger.getEvidenceForContext(evidenceId, {
      brain_id: "other-brain",
      principal_id: "principal-owner",
      source_ids: [sourceId],
    })).toBeNull();
  });

  test("a raw-to-normalized parser drift fails verification", async () => {
    const snapshot = await acquireText();
    const normalizer = fixtureNormalizer();
    const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, normalizer);
    const drifted = fixtureNormalizer("1.0.0", "Changed parser output.");

    await expect(evidenceLedger.verifyBundle(result.normalized_document.normalized_document_id, drifted))
      .rejects.toThrow("Raw-to-normalized mapping drift");
  });

  test("rejects an orphan mapping before mutating a projection", async () => {
    const snapshot = await acquireText();
    const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, fixtureNormalizer());
    const bundle = structuredClone(
      await evidenceLedger.getCanonicalBundle(result.normalized_document.normalized_document_id),
    );
    bundle.evidence_items.pop();
    const emptyProjection = new InMemoryCoeEvidenceProjection();

    await expect(emptyProjection.projectBundle(bundle as CanonicalEvidenceBundle))
      .rejects.toThrow("invalid canonical bundle");
    expect(emptyProjection.documents.size).toBe(0);
    expect(emptyProjection.evidence.size).toBe(0);
  });

  test("the Markdown normalizer creates line-resolvable evidence without a chunker", async () => {
    const snapshot = await acquireText(
      "# Methods\n\nThe method is deterministic.\n\n| Metric | Value |\n| --- | --- |\n| Recall | 0.91 |\n",
      "text/markdown",
    );
    const normalizer = new MarkdownDocumentNormalizer();
    const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, normalizer);

    expect(result.evidence_items.some(({ evidence_type }) => evidence_type === "table_cell")).toBe(true);
    expect(result.normalized_document.mappings.every(({ raw_locator }) =>
      raw_locator.kind === "line_range" || raw_locator.kind === "table_cell"
    )).toBe(true);
    expect((await evidenceLedger.verifyBundle(
      result.normalized_document.normalized_document_id,
      normalizer,
    )).raw_mapping_verified).toBe(true);
  });
});

describe("CoE evidence SQL projection on PGLite", () => {
  let root: string;
  let engine: PGLiteEngine;
  let snapshotLedger: CoeSnapshotLedger;
  let evidenceLedger: CoeEvidenceLedger;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gbrain-coe-evidence-pglite-"));
    engine = new PGLiteEngine();
    await engine.connect({ engine: "pglite" });
    await engine.initSchema();
    snapshotLedger = new CoeSnapshotLedger({
      root,
      projection: new SqlCoeSnapshotProjection(engine),
      clock: () => new Date(FIXED_TIME),
      nonce: () => crypto.randomUUID(),
    });
    evidenceLedger = new CoeEvidenceLedger({
      root,
      snapshotLedger,
      projection: new SqlCoeEvidenceProjection(engine),
      clock: () => new Date(FIXED_TIME),
      nonce: () => crypto.randomUUID(),
    });
  });

  afterAll(async () => {
    await engine.disconnect();
    await rm(root, { recursive: true, force: true });
  });

  test("projects atomically and rebuilds all document, section, mapping, and evidence rows", async () => {
    const snapshot = await snapshotLedger.acquire({
      source: exampleSource(),
      content: "# SQL projection\n\nStable evidence row.\n",
      requested_uri: "https://example.invalid/evidence",
      final_uri: "https://example.invalid/evidence",
      media_type: "text/markdown",
      acquisition_method: "http",
      acquired_at: FIXED_TIME,
    });
    const result = await evidenceLedger.normalizeSnapshot(
      snapshot.snapshot!.snapshot_id,
      new MarkdownDocumentNormalizer(),
    );
    expect(result.outcome).toBe("promoted");

    const counts = await engine.executeRaw<{
      documents: number;
      sections: number;
      mappings: number;
      evidence_items: number;
    }>(`SELECT
      (SELECT COUNT(*)::int FROM coe_normalized_documents) AS documents,
      (SELECT COUNT(*)::int FROM coe_document_sections) AS sections,
      (SELECT COUNT(*)::int FROM coe_normalized_mappings) AS mappings,
      (SELECT COUNT(*)::int FROM coe_evidence_items) AS evidence_items`);
    expect(counts[0]).toEqual({
      documents: 1,
      sections: result.normalized_document.sections.length,
      mappings: result.normalized_document.mappings.length,
      evidence_items: result.evidence_items.length,
    });
    const jsonKinds = await engine.executeRaw<Record<string, string>>(`SELECT
      (SELECT jsonb_typeof(record_json) FROM coe_sources LIMIT 1) AS source_record,
      (SELECT jsonb_typeof(scope_json) FROM coe_snapshots LIMIT 1) AS snapshot_scope,
      (SELECT jsonb_typeof(record_json) FROM coe_acquisitions LIMIT 1) AS acquisition_record,
      (SELECT jsonb_typeof(quarantine_reasons) FROM coe_acquisitions LIMIT 1) AS quarantine_reasons,
      (SELECT jsonb_typeof(record_json) FROM coe_normalized_documents LIMIT 1) AS document_record,
      (SELECT jsonb_typeof(warnings_json) FROM coe_normalized_documents LIMIT 1) AS warnings,
      (SELECT jsonb_typeof(record_json) FROM coe_document_sections LIMIT 1) AS section_record,
      (SELECT jsonb_typeof(raw_locator_json) FROM coe_normalized_mappings LIMIT 1) AS mapping_locator,
      (SELECT jsonb_typeof(record_json) FROM coe_evidence_items LIMIT 1) AS evidence_record,
      (SELECT jsonb_typeof(scope_json) FROM coe_evidence_items LIMIT 1) AS evidence_scope`);
    expect(jsonKinds[0]).toEqual({
      source_record: "object",
      snapshot_scope: "object",
      acquisition_record: "object",
      quarantine_reasons: "array",
      document_record: "object",
      warnings: "array",
      section_record: "object",
      mapping_locator: "object",
      evidence_record: "object",
      evidence_scope: "object",
    });

    await engine.executeRaw("TRUNCATE TABLE coe_evidence_items, coe_normalized_mappings, coe_document_sections, coe_normalized_documents");
    expect(await evidenceLedger.rebuildProjection()).toEqual({
      documents: 1,
      evidence_items: result.evidence_items.length,
    });
    const restored = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM coe_evidence_items");
    expect(Number(restored[0]?.count)).toBe(result.evidence_items.length);
  });

  test("SQL projection rejects a document scope wider than its parent snapshot", async () => {
    const snapshot = await snapshotLedger.acquire({
      source: exampleSource(),
      content: "Scope boundary fixture.",
      requested_uri: "https://example.invalid/evidence",
      final_uri: "https://example.invalid/evidence",
      media_type: "text/plain",
      acquisition_method: "http",
      acquired_at: "2026-08-04T19:01:00.000Z",
    });
    const canonicalLedger = new CoeEvidenceLedger({
      root,
      snapshotLedger,
      projection: new InMemoryCoeEvidenceProjection(),
      clock: () => new Date("2026-08-04T19:01:00.000Z"),
      nonce: () => crypto.randomUUID(),
    });
    const normalized = await canonicalLedger.normalizeSnapshot(
      snapshot.snapshot!.snapshot_id,
      fixtureNormalizer("1.0.1", "Scope boundary evidence."),
    );
    const bundle = structuredClone(await canonicalLedger.getCanonicalBundle(
      normalized.normalized_document.normalized_document_id,
    ));
    bundle.normalized_document.scope.brain_id = "other-brain";
    for (const evidence of bundle.evidence_items) evidence.scope.brain_id = "other-brain";

    await expect(new SqlCoeEvidenceProjection(engine).projectBundle(bundle))
      .rejects.toMatchObject({ code: "scope_widening" });
    const rows = await engine.executeRaw<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM coe_normalized_documents WHERE normalized_document_id = $1",
      [bundle.normalized_document.normalized_document_id],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
