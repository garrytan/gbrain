import {
  CoeContractError,
  makeCoeId,
  parseCoeContract,
  sha256Bytes,
  type EvidenceItemContract,
} from "../contracts/index.ts";
import type { CreateEvidenceItemInput } from "./types.ts";
import { sliceUtf8 } from "./utf8.ts";

export function createEvidenceItem(input: CreateEvidenceItemInput): EvidenceItemContract {
  const normalizedText = sliceUtf8(
    input.normalized_bytes,
    input.normalized_span.start,
    input.normalized_span.end,
  );
  if (input.expected_text !== undefined && input.expected_text !== normalizedText) {
    throw new CoeContractError("hash_mismatch", "Expected evidence text does not match its normalized span");
  }

  const section = input.document.sections.find(({ section_id }) => section_id === input.section_id);
  if (!section) {
    throw new CoeContractError("invalid_contract", "Evidence references an unknown normalized section");
  }
  if (
    input.normalized_span.start < section.normalized_span.start ||
    input.normalized_span.end > section.normalized_span.end
  ) {
    throw new CoeContractError("invalid_contract", "Evidence span is outside its declared section");
  }

  const mappings = input.document.mappings.filter((mapping) =>
    mapping.section_id === input.section_id &&
    mapping.normalized_start <= input.normalized_span.start &&
    mapping.normalized_end >= input.normalized_span.end
  );
  if (mappings.length !== 1) {
    throw new CoeContractError(
      "invalid_contract",
      mappings.length === 0
        ? "Evidence span has no resolvable raw mapping"
        : "Evidence span has an ambiguous raw mapping",
    );
  }
  const rawLocator = mappings[0]!.raw_locator;
  const textHash = sha256Bytes(normalizedText);
  const evidenceId = makeCoeId("evd", {
    normalized_document_id: input.document.normalized_document_id,
    section_id: input.section_id,
    evidence_type: input.evidence_type,
    normalized_span: input.normalized_span,
    text_hash: textHash,
    raw_locator: rawLocator,
  });

  return parseCoeContract("evidence_item", {
    schema_version: "1.0.0",
    evidence_id: evidenceId,
    snapshot_id: input.document.snapshot_id,
    normalized_document_id: input.document.normalized_document_id,
    section_id: input.section_id,
    evidence_type: input.evidence_type,
    normalized_text: normalizedText,
    text_hash: textHash,
    normalized_span: input.normalized_span,
    raw_locator: rawLocator,
    status: "active",
    scope: input.document.scope,
    created_at: input.created_at,
  }) as EvidenceItemContract;
}
