import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { canonicalizeJson, makeCoeId, type SourceContract } from "../../src/coe/contracts/index.ts";
import {
  CoeEvidenceLedger,
  MarkdownDocumentNormalizer,
  SqlCoeEvidenceProjection,
} from "../../src/coe/evidence/index.ts";
import { CoeSnapshotLedger, SqlCoeSnapshotProjection } from "../../src/coe/registry/index.ts";
import type { PostgresEngine } from "../../src/core/postgres-engine.ts";
import { hasDatabase, setupDB, teardownDB } from "./helpers.ts";

const describePostgres = hasDatabase() ? describe : describe.skip;
const FIRST_TIME = "2026-08-04T12:00:00.000Z";

function source(): SourceContract {
  const canonicalUri = "https://example.invalid/coe-postgres";
  const sourceId = makeCoeId("src", { canonical_uri: canonicalUri, source_kind: "report" });
  return {
    schema_version: "1.0.0",
    source_id: sourceId,
    source_kind: "report",
    title: "CoE PostgreSQL parity fixture",
    canonical_uri: canonicalUri,
    authors: [],
    language: "en",
    external_identifiers: [],
    scope: {
      brain_id: "coe-postgres-e2e",
      visibility: "private",
      owner_principal: "coe-postgres-test",
      reader_principals: [],
      source_ids: [sourceId],
    },
    created_at: FIRST_TIME,
    created_by: { actor_type: "system", actor_id: "coe-postgres-test" },
  };
}

describePostgres("CoE snapshot and evidence ledger PostgreSQL projections", () => {
  let root: string;
  let engine: PostgresEngine;
  let projection: SqlCoeSnapshotProjection;
  let ledger: CoeSnapshotLedger;
  let evidenceLedger: CoeEvidenceLedger;
  let now = FIRST_TIME;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gbrain-coe-postgres-"));
    engine = await setupDB();
    projection = new SqlCoeSnapshotProjection(engine);
    ledger = new CoeSnapshotLedger({
      root,
      projection,
      clock: () => new Date(now),
      nonce: () => crypto.randomUUID(),
    });
    evidenceLedger = new CoeEvidenceLedger({
      root,
      snapshotLedger: ledger,
      projection: new SqlCoeEvidenceProjection(engine),
      clock: () => new Date(now),
      nonce: () => crypto.randomUUID(),
    });
  }, 60_000);

  afterAll(async () => {
    await teardownDB();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  test("migration 68 exposes every constrained CoE projection table with RLS", async () => {
    const tables = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name LIKE 'coe_%'
        ORDER BY table_name`,
    );
    expect(tables.map(({ table_name }) => table_name)).toEqual([
      "coe_acquisition_redirects",
      "coe_acquisitions",
      "coe_document_sections",
      "coe_evidence_items",
      "coe_normalized_documents",
      "coe_normalized_mappings",
      "coe_raw_objects",
      "coe_snapshot_events",
      "coe_snapshots",
      "coe_sources",
    ]);
    const rls = await engine.executeRaw<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [tables.map(({ table_name }) => table_name)],
    );
    expect(rls).toHaveLength(10);
    expect(rls.every(({ relrowsecurity }) => relrowsecurity)).toBe(true);
  });

  test("deduplication, supersession, failure journaling, and retraction stay transactionally consistent", async () => {
    const input = {
      source: source(),
      requested_uri: "https://example.invalid/coe-postgres",
      final_uri: "https://example.invalid/coe-postgres",
      media_type: "text/plain",
      expected_media_types: ["text/plain"],
      acquisition_method: "http" as const,
      acquired_at: FIRST_TIME,
    };
    const first = await ledger.acquire({ ...input, content: "postgres version one" });
    const immutableFirst = canonicalizeJson(await ledger.getCanonicalSnapshot(first.snapshot!.snapshot_id));
    const duplicate = await ledger.acquire({ ...input, content: "postgres version one" });
    now = "2026-08-04T12:01:00.000Z";
    const successor = await ledger.acquire({ ...input, content: "postgres version two", acquired_at: now });
    const failed = await ledger.recordFailure({
      source: source(),
      requested_uri: "https://example.invalid/unavailable",
      acquisition_method: "http",
      error_code: "timeout",
      started_at: now,
    });

    expect(first.outcome).toBe("promoted");
    expect(duplicate.outcome).toBe("duplicate");
    expect(successor.snapshot?.supersedes_snapshot_id).toBe(first.snapshot?.snapshot_id);
    expect(failed.outcome).toBe("failed");
    expect(await projection.getSnapshotStatus(first.snapshot!.snapshot_id)).toBe("superseded");

    const counts = await engine.executeRaw<{
      sources: number;
      raw_objects: number;
      snapshots: number;
      acquisitions: number;
      events: number;
    }>(`SELECT
          (SELECT COUNT(*)::int FROM coe_sources) AS sources,
          (SELECT COUNT(*)::int FROM coe_raw_objects) AS raw_objects,
          (SELECT COUNT(*)::int FROM coe_snapshots) AS snapshots,
          (SELECT COUNT(*)::int FROM coe_acquisitions) AS acquisitions,
          (SELECT COUNT(*)::int FROM coe_snapshot_events) AS events`);
    expect(counts[0]).toEqual({ sources: 1, raw_objects: 2, snapshots: 2, acquisitions: 4, events: 1 });

    now = "2026-08-04T12:02:00.000Z";
    await ledger.retractSnapshot(
      successor.snapshot!.snapshot_id,
      "postgres parity retraction",
      { actor_type: "human", actor_id: "coe-reviewer" },
    );
    expect(await projection.getSnapshotStatus(successor.snapshot!.snapshot_id)).toBe("retracted");
    expect((await ledger.readSnapshotBytes(successor.snapshot!.snapshot_id)).toString("utf8")).toBe("postgres version two");
    expect(canonicalizeJson(await ledger.getCanonicalSnapshot(first.snapshot!.snapshot_id))).toBe(immutableFirst);

    const failedRows = await engine.executeRaw<{ actual_hash: string | null; snapshot_id: string | null }>(
      "SELECT actual_hash, snapshot_id FROM coe_acquisitions WHERE event_id = $1",
      [failed.event_id],
    );
    expect(failedRows).toEqual([{ actual_hash: null, snapshot_id: null }]);

    const normalized = await evidenceLedger.normalizeSnapshot(
      first.snapshot!.snapshot_id,
      new MarkdownDocumentNormalizer(),
    );
    expect(normalized.outcome).toBe("promoted");
    const evidenceCounts = await engine.executeRaw<{
      documents: number;
      sections: number;
      mappings: number;
      evidence_items: number;
    }>(`SELECT
          (SELECT COUNT(*)::int FROM coe_normalized_documents) AS documents,
          (SELECT COUNT(*)::int FROM coe_document_sections) AS sections,
          (SELECT COUNT(*)::int FROM coe_normalized_mappings) AS mappings,
          (SELECT COUNT(*)::int FROM coe_evidence_items) AS evidence_items`);
    expect(evidenceCounts[0]).toEqual({
      documents: 1,
      sections: normalized.normalized_document.sections.length,
      mappings: normalized.normalized_document.mappings.length,
      evidence_items: normalized.evidence_items.length,
    });
    const jsonKinds = await engine.executeRaw<Record<string, string>>(`SELECT
      (SELECT jsonb_typeof(record_json) FROM coe_sources LIMIT 1) AS source_record,
      (SELECT jsonb_typeof(scope_json) FROM coe_snapshots LIMIT 1) AS snapshot_scope,
      (SELECT jsonb_typeof(record_json) FROM coe_acquisitions LIMIT 1) AS acquisition_record,
      (SELECT jsonb_typeof(quarantine_reasons) FROM coe_acquisitions LIMIT 1) AS quarantine_reasons,
      (SELECT jsonb_typeof(event_json) FROM coe_snapshot_events LIMIT 1) AS event_record,
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
      event_record: "object",
      document_record: "object",
      warnings: "array",
      section_record: "object",
      mapping_locator: "object",
      evidence_record: "object",
      evidence_scope: "object",
    });

    await engine.executeRaw(
      "TRUNCATE TABLE coe_evidence_items, coe_normalized_mappings, coe_document_sections, coe_normalized_documents",
    );
    expect(await evidenceLedger.rebuildProjection()).toEqual({
      documents: 1,
      evidence_items: normalized.evidence_items.length,
    });
  });
});
