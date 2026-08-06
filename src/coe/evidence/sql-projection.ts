import type { BrainEngine } from "../../core/engine.ts";
import { executeRawJsonb } from "../../core/sql-query.ts";
import {
  AccessScopeSchema,
  CoeContractError,
  assertScopeDoesNotWiden,
  canonicalizeJson,
  sha256Canonical,
} from "../contracts/index.ts";
import {
  EvidenceBundleSchema,
  type CanonicalEvidenceBundle,
  type CoeEvidenceProjection,
} from "./types.ts";

function recordHash(value: unknown): string {
  return `sha256:${sha256Canonical(value)}`;
}

function canonicalJsonValue(value: unknown): unknown {
  return JSON.parse(canonicalizeJson(value));
}

function parseScopeColumn(value: unknown) {
  let decoded = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new CoeContractError("invalid_contract", "Snapshot projection contains invalid scope JSON");
    }
  }
  const parsed = AccessScopeSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CoeContractError("invalid_contract", "Snapshot projection contains an invalid scope");
  }
  return parsed.data;
}

export class SqlCoeEvidenceProjection implements CoeEvidenceProjection {
  constructor(private readonly engine: BrainEngine) {}

  async projectBundle(bundle: CanonicalEvidenceBundle): Promise<void> {
    const parsed = EvidenceBundleSchema.safeParse(bundle);
    if (!parsed.success) {
      throw new CoeContractError("invalid_contract", "Evidence projection rejected an invalid canonical bundle");
    }
    const canonicalBundle = parsed.data;
    await this.engine.transaction(async (tx) => {
      const document = canonicalBundle.normalized_document;
      const snapshotRows = await tx.executeRaw<{ snapshot_id: string; scope_json: unknown }>(
        "SELECT snapshot_id, scope_json FROM coe_snapshots WHERE snapshot_id = $1",
        [document.snapshot_id],
      );
      if (snapshotRows.length !== 1) {
        throw new CoeContractError("invalid_contract", "Cannot project a normalized document without its snapshot");
      }
      const snapshotScope = parseScopeColumn(snapshotRows[0]!.scope_json);
      assertScopeDoesNotWiden(snapshotScope, document.scope);

      const documentHash = recordHash(document);
      await executeRawJsonb(
        tx,
        `INSERT INTO coe_normalized_documents
           (normalized_document_id, snapshot_id, schema_version, content_hash, byte_size,
            object_key, normalizer_name, normalizer_version, normalizer_config_hash,
            record_hash, record_json, scope_json, warnings_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 $10, $12::jsonb, $13::jsonb, $14::jsonb, $11::timestamptz)
         ON CONFLICT (normalized_document_id) DO NOTHING`,
        [
          document.normalized_document_id,
          document.snapshot_id,
          document.schema_version,
          document.content_hash,
          document.byte_size,
          document.object_key,
          document.normalizer.name,
          document.normalizer.version,
          document.normalizer.config_hash,
          documentHash,
          document.created_at,
        ],
        [
          canonicalJsonValue(document),
          canonicalJsonValue(document.scope),
          canonicalJsonValue(document.warnings),
        ],
      );
      const documentRows = await tx.executeRaw<{ record_hash: string }>(
        "SELECT record_hash FROM coe_normalized_documents WHERE normalized_document_id = $1",
        [document.normalized_document_id],
      );
      if (documentRows[0]?.record_hash !== documentHash) {
        throw new CoeContractError("id_mismatch", "Normalized-document projection conflicts with canonical record");
      }

      for (const section of document.sections) {
        const sectionHash = recordHash(section);
        await executeRawJsonb(
          tx,
          `INSERT INTO coe_document_sections
             (normalized_document_id, section_id, parent_section_id, ordinal, level, title,
              normalized_start, normalized_end, text_hash, record_hash, record_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
           ON CONFLICT (normalized_document_id, section_id) DO NOTHING`,
          [
            document.normalized_document_id,
            section.section_id,
            section.parent_section_id ?? null,
            section.ordinal,
            section.level,
            section.title ?? null,
            section.normalized_span.start,
            section.normalized_span.end,
            section.text_hash,
            sectionHash,
          ],
          [canonicalJsonValue(section)],
        );
        const rows = await tx.executeRaw<{ record_hash: string }>(
          `SELECT record_hash FROM coe_document_sections
            WHERE normalized_document_id = $1 AND section_id = $2`,
          [document.normalized_document_id, section.section_id],
        );
        if (rows[0]?.record_hash !== sectionHash) {
          throw new CoeContractError("id_mismatch", "Section projection conflicts with canonical record");
        }
      }

      for (const [ordinal, mapping] of document.mappings.entries()) {
        const mappingHash = recordHash(mapping);
        await executeRawJsonb(
          tx,
          `INSERT INTO coe_normalized_mappings
             (normalized_document_id, ordinal, section_id, normalized_start, normalized_end,
              raw_locator_json, record_hash, record_json)
           VALUES ($1, $2, $3, $4, $5, $7::jsonb, $6, $8::jsonb)
           ON CONFLICT (normalized_document_id, ordinal) DO NOTHING`,
          [
            document.normalized_document_id,
            ordinal,
            mapping.section_id,
            mapping.normalized_start,
            mapping.normalized_end,
            mappingHash,
          ],
          [canonicalJsonValue(mapping.raw_locator), canonicalJsonValue(mapping)],
        );
        const rows = await tx.executeRaw<{ record_hash: string }>(
          `SELECT record_hash FROM coe_normalized_mappings
            WHERE normalized_document_id = $1 AND ordinal = $2`,
          [document.normalized_document_id, ordinal],
        );
        if (rows[0]?.record_hash !== mappingHash) {
          throw new CoeContractError("id_mismatch", "Normalized mapping projection conflicts with canonical record");
        }
      }

      for (const evidence of canonicalBundle.evidence_items) {
        assertScopeDoesNotWiden(document.scope, evidence.scope);
        const evidenceHash = recordHash(evidence);
        await executeRawJsonb(
          tx,
          `INSERT INTO coe_evidence_items
             (evidence_id, snapshot_id, normalized_document_id, section_id, schema_version,
              evidence_type, normalized_text, text_hash, normalized_start, normalized_end,
              raw_locator_json, initial_status, status, supersedes_evidence_id,
              retraction_reason, record_hash, record_json, scope_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   $16::jsonb, $11, $11, $12, $13, $14, $17::jsonb, $18::jsonb, $15::timestamptz)
           ON CONFLICT (evidence_id) DO NOTHING`,
          [
            evidence.evidence_id,
            evidence.snapshot_id,
            evidence.normalized_document_id,
            evidence.section_id,
            evidence.schema_version,
            evidence.evidence_type,
            evidence.normalized_text,
            evidence.text_hash,
            evidence.normalized_span.start,
            evidence.normalized_span.end,
            evidence.status,
            evidence.supersedes_evidence_id ?? null,
            evidence.retraction_reason ?? null,
            evidenceHash,
            evidence.created_at,
          ],
          [
            canonicalJsonValue(evidence.raw_locator),
            canonicalJsonValue(evidence),
            canonicalJsonValue(evidence.scope),
          ],
        );
        const rows = await tx.executeRaw<{ record_hash: string }>(
          "SELECT record_hash FROM coe_evidence_items WHERE evidence_id = $1",
          [evidence.evidence_id],
        );
        if (rows[0]?.record_hash !== evidenceHash) {
          throw new CoeContractError("id_mismatch", "Evidence projection conflicts with canonical record");
        }
      }

      const counts = await tx.executeRaw<{
        sections: number | string;
        mappings: number | string;
        evidence_items: number | string;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM coe_document_sections WHERE normalized_document_id = $1) AS sections,
           (SELECT COUNT(*) FROM coe_normalized_mappings WHERE normalized_document_id = $1) AS mappings,
           (SELECT COUNT(*) FROM coe_evidence_items WHERE normalized_document_id = $1) AS evidence_items`,
        [document.normalized_document_id],
      );
      if (
        Number(counts[0]?.sections) !== document.sections.length ||
        Number(counts[0]?.mappings) !== document.mappings.length ||
        Number(counts[0]?.evidence_items) !== canonicalBundle.evidence_items.length
      ) {
        throw new CoeContractError("id_mismatch", "Evidence projection contains non-canonical child rows");
      }
    });
  }
}
