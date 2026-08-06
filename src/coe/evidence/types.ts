import { z } from "zod";

import {
  EvidenceItemSchema,
  NormalizedDocumentSchema,
  canonicalizeJson,
  type EvidenceItemContract,
  type NormalizedDocumentContract,
  type RawLocator,
  type SourceSnapshotContract,
} from "../contracts/index.ts";
import type { CoeSnapshotLedger } from "../registry/index.ts";

export const EVIDENCE_BUNDLE_VERSION = "1.0.0" as const;

export const NORMALIZATION_BLOCK_KINDS = [
  "heading",
  "paragraph",
  "quote",
  "list_item",
  "table_cell",
  "figure",
  "code_block",
  "metadata",
] as const;

export type NormalizationBlockKind = (typeof NORMALIZATION_BLOCK_KINDS)[number];

export interface NormalizationBlock {
  block_id: string;
  kind: NormalizationBlockKind;
  text: string;
  raw_text?: string;
  raw_locator: RawLocator;
  heading_level?: number;
}

export interface NormalizationWarning {
  code: string;
  message: string;
  severity: "warning" | "blocking";
  locator?: RawLocator;
}

export interface NormalizerOutput {
  blocks: NormalizationBlock[];
  warnings: NormalizationWarning[];
}

export interface NormalizerDescriptor {
  name: string;
  version: string;
  config_hash: string;
}

export interface DocumentNormalizer {
  readonly descriptor: NormalizerDescriptor;
  supports(mediaType: string): boolean;
  normalize(input: {
    bytes: Uint8Array;
    snapshot: SourceSnapshotContract;
  }): Promise<NormalizerOutput>;
}

export const EvidenceBundleSchema = z
  .strictObject({
    bundle_version: z.literal(EVIDENCE_BUNDLE_VERSION),
    normalized_document: NormalizedDocumentSchema,
    evidence_items: z.array(EvidenceItemSchema).min(1),
  })
  .superRefine((bundle, context) => {
    const evidenceIds = new Set<string>();
    const sectionIds = new Set(bundle.normalized_document.sections.map(({ section_id }) => section_id));
    const mappingUses = new Map<string, number>();
    const mappingBySpan = new Map(bundle.normalized_document.mappings.map((mapping) => [
      `${mapping.section_id}:${mapping.normalized_start}:${mapping.normalized_end}`,
      mapping,
    ]));
    for (const [index, evidence] of bundle.evidence_items.entries()) {
      if (evidenceIds.has(evidence.evidence_id)) {
        context.addIssue({
          code: "custom",
          path: ["evidence_items", index, "evidence_id"],
          message: "Evidence IDs must be unique within a bundle",
        });
      }
      evidenceIds.add(evidence.evidence_id);
      if (evidence.snapshot_id !== bundle.normalized_document.snapshot_id) {
        context.addIssue({
          code: "custom",
          path: ["evidence_items", index, "snapshot_id"],
          message: "Evidence snapshot_id must match its normalized document",
        });
      }
      if (evidence.normalized_document_id !== bundle.normalized_document.normalized_document_id) {
        context.addIssue({
          code: "custom",
          path: ["evidence_items", index, "normalized_document_id"],
          message: "Evidence normalized_document_id must match its bundle",
        });
      }
      if (!sectionIds.has(evidence.section_id)) {
        context.addIssue({
          code: "custom",
          path: ["evidence_items", index, "section_id"],
          message: "Evidence section_id must reference its normalized document",
        });
      }
      const mappingKey = `${evidence.section_id}:${evidence.normalized_span.start}:${evidence.normalized_span.end}`;
      const mapping = mappingBySpan.get(mappingKey);
      if (!mapping || canonicalizeJson(mapping.raw_locator) !== canonicalizeJson(evidence.raw_locator)) {
        context.addIssue({
          code: "custom",
          path: ["evidence_items", index, "raw_locator"],
          message: "Evidence must resolve to exactly its canonical raw mapping",
        });
      } else {
        mappingUses.set(mappingKey, (mappingUses.get(mappingKey) ?? 0) + 1);
      }
    }
    for (const [index, mapping] of bundle.normalized_document.mappings.entries()) {
      const mappingKey = `${mapping.section_id}:${mapping.normalized_start}:${mapping.normalized_end}`;
      if (mappingUses.get(mappingKey) !== 1) {
        context.addIssue({
          code: "custom",
          path: ["normalized_document", "mappings", index],
          message: "Every normalized mapping must have exactly one EvidenceItem",
        });
      }
    }
  });

export type CanonicalEvidenceBundle = z.output<typeof EvidenceBundleSchema>;

export interface CoeEvidenceProjection {
  projectBundle(bundle: CanonicalEvidenceBundle): Promise<void>;
}

export interface EvidenceLedgerOptions {
  root: string;
  snapshotLedger: Pick<CoeSnapshotLedger, "getCanonicalSnapshot" | "readSnapshotBytes">;
  projection: CoeEvidenceProjection;
  clock?: () => Date;
  nonce?: () => string;
}

export interface NormalizeSnapshotResult {
  outcome: "promoted" | "duplicate";
  normalized_document: NormalizedDocumentContract;
  evidence_items: EvidenceItemContract[];
}

export interface EvidenceBundleVerification {
  normalized_document_id: string;
  evidence_items: number;
  mappings: number;
  sections: number;
  raw_mapping_verified: boolean;
}

export interface EvidenceReadContext {
  brain_id: string;
  principal_id?: string;
  source_ids: string[];
}

export interface CreateEvidenceItemInput {
  document: NormalizedDocumentContract;
  normalized_bytes: Uint8Array;
  section_id: string;
  normalized_span: { start: number; end: number };
  evidence_type: EvidenceItemContract["evidence_type"];
  created_at: string;
  expected_text?: string;
}
