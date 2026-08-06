import {
  CoeContractError,
  assertScopeDoesNotWiden,
  makeCoeId,
  parseCoeContract,
  sha256Bytes,
  sha256Canonical,
  type EvidenceItemContract,
  type NormalizedDocumentContract,
  type SourceSnapshotContract,
} from "../contracts/index.ts";
import { createEvidenceItem } from "./evidence-item.ts";
import {
  EvidenceBundleSchema,
  type CanonicalEvidenceBundle,
  type NormalizationBlock,
  type NormalizerDescriptor,
  type NormalizerOutput,
} from "./types.ts";
import { normalizeUnicodeText } from "./utf8.ts";

export interface CompiledEvidenceBundle {
  bundle: CanonicalEvidenceBundle;
  normalized_bytes: Buffer;
}

function normalizedObjectKey(contentHash: string): string {
  const hex = contentHash.slice("sha256:".length);
  return `objects/sha256/${hex.slice(0, 2)}/${hex}`;
}

function normalizeBlock(block: NormalizationBlock): NormalizationBlock {
  const text = normalizeUnicodeText(block.text).trim();
  if (!block.block_id.trim()) throw new CoeContractError("invalid_contract", "Normalizer emitted an empty block ID");
  if (!text) throw new CoeContractError("invalid_contract", `Normalizer block ${block.block_id} is empty`);
  if (block.kind === "heading") {
    if (!Number.isInteger(block.heading_level) || block.heading_level! < 1 || block.heading_level! > 6) {
      throw new CoeContractError("invalid_contract", `Heading block ${block.block_id} requires level 1 through 6`);
    }
  } else if (block.heading_level !== undefined) {
    throw new CoeContractError("invalid_contract", `Non-heading block ${block.block_id} cannot carry heading_level`);
  }
  return { ...block, block_id: block.block_id.trim(), text };
}

function evidenceType(block: NormalizationBlock): EvidenceItemContract["evidence_type"] {
  switch (block.kind) {
    case "table_cell": return "table_cell";
    case "figure": return "figure";
    case "code_block": return "code_block";
    case "heading":
    case "metadata": return "metadata";
    default: return "quote";
  }
}

export function compileEvidenceBundle(
  snapshot: SourceSnapshotContract,
  descriptor: NormalizerDescriptor,
  output: NormalizerOutput,
  createdAt: string,
): CompiledEvidenceBundle {
  if (!output.blocks.length) throw new CoeContractError("invalid_contract", "Normalizer emitted no evidence blocks");
  const blocks = output.blocks.map(normalizeBlock);
  const blockIds = new Set<string>();
  for (const block of blocks) {
    if (blockIds.has(block.block_id)) {
      throw new CoeContractError("id_mismatch", `Normalizer emitted duplicate block ID ${block.block_id}`);
    }
    blockIds.add(block.block_id);
  }

  const encodedBlocks = blocks.map((block) => Buffer.from(block.text, "utf8"));
  const separator = Buffer.from("\n\n", "utf8");
  const normalizedBytes = Buffer.concat(
    encodedBlocks.flatMap((bytes, index) => index === encodedBlocks.length - 1 ? [bytes] : [bytes, separator]),
  );
  const contentHash = sha256Bytes(normalizedBytes);
  const normalizedDocumentId = makeCoeId("ndoc", {
    snapshot_id: snapshot.snapshot_id,
    content_hash: contentHash,
    normalizer: descriptor,
  });

  const rootSectionId = `section_${sha256Canonical({ normalized_document_id: normalizedDocumentId, root: true })}`;
  const sections: NormalizedDocumentContract["sections"] = [{
    section_id: rootSectionId,
    ordinal: 0,
    level: 0,
    title: "Document",
    normalized_span: { start: 0, end: normalizedBytes.byteLength },
    text_hash: contentHash,
  }];
  const mappings: NormalizedDocumentContract["mappings"] = [];
  const headingStack = new Map<number, { section_id: string; level: number }>();
  const evidenceInputs: Array<{
    section_id: string;
    normalized_span: { start: number; end: number };
    evidence_type: EvidenceItemContract["evidence_type"];
  }> = [];
  let byteOffset = 0;

  for (const [index, block] of blocks.entries()) {
    const blockBytes = encodedBlocks[index]!;
    const span = { start: byteOffset, end: byteOffset + blockBytes.byteLength };
    let parentSectionId = rootSectionId;
    let level = 1;
    if (block.kind === "heading") {
      const headingLevel = block.heading_level!;
      for (const existingLevel of [...headingStack.keys()]) {
        if (existingLevel >= headingLevel) headingStack.delete(existingLevel);
      }
      const parents = [...headingStack.entries()].filter(([candidate]) => candidate < headingLevel);
      const parent = parents.sort(([left], [right]) => right - left)[0]?.[1];
      if (parent) parentSectionId = parent.section_id;
      level = headingLevel;
    } else {
      const parent = [...headingStack.entries()].sort(([left], [right]) => right - left)[0]?.[1];
      if (parent) {
        parentSectionId = parent.section_id;
        level = parent.level + 1;
      }
    }
    const sectionId = `section_${sha256Canonical({
      normalized_document_id: normalizedDocumentId,
      block_id: block.block_id,
      span,
    })}`;
    sections.push({
      section_id: sectionId,
      parent_section_id: parentSectionId,
      ordinal: index + 1,
      level,
      ...(block.kind === "heading" ? { title: block.text } : {}),
      normalized_span: span,
      text_hash: sha256Bytes(blockBytes),
    });
    if (block.kind === "heading") {
      headingStack.set(block.heading_level!, { section_id: sectionId, level });
    }
    mappings.push({
      section_id: sectionId,
      normalized_start: span.start,
      normalized_end: span.end,
      raw_locator: block.raw_locator,
    });
    evidenceInputs.push({ section_id: sectionId, normalized_span: span, evidence_type: evidenceType(block) });
    byteOffset = span.end + (index === blocks.length - 1 ? 0 : separator.byteLength);
  }

  const document = parseCoeContract("normalized_document", {
    schema_version: "1.0.0",
    normalized_document_id: normalizedDocumentId,
    snapshot_id: snapshot.snapshot_id,
    content_hash: contentHash,
    byte_size: normalizedBytes.byteLength,
    object_key: normalizedObjectKey(contentHash),
    normalizer: descriptor,
    sections,
    mappings,
    warnings: output.warnings,
    scope: snapshot.scope,
    created_at: createdAt,
  }) as NormalizedDocumentContract;
  assertScopeDoesNotWiden(snapshot.scope, document.scope);

  const evidenceItems = evidenceInputs.map((input) => createEvidenceItem({
    document,
    normalized_bytes: normalizedBytes,
    section_id: input.section_id,
    normalized_span: input.normalized_span,
    evidence_type: input.evidence_type,
    created_at: createdAt,
  }));
  for (const evidence of evidenceItems) assertScopeDoesNotWiden(document.scope, evidence.scope);

  return {
    bundle: EvidenceBundleSchema.parse({
      bundle_version: "1.0.0",
      normalized_document: document,
      evidence_items: evidenceItems,
    }),
    normalized_bytes: normalizedBytes,
  };
}
