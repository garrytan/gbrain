import {
  CoeContractError,
  assertScopeDoesNotWiden,
  canonicalizeJson,
  makeCoeId,
  sha256Bytes,
  sha256Canonical,
  type EvidenceItemContract,
  type NormalizedDocumentContract,
} from "../contracts/index.ts";
import { ContentAddressedStore } from "../registry/index.ts";
import { canReadEvidenceScope } from "./access.ts";
import { compileEvidenceBundle } from "./compiler.ts";
import { createEvidenceItem } from "./evidence-item.ts";
import {
  EvidenceBundleSchema,
  type CanonicalEvidenceBundle,
  type DocumentNormalizer,
  type EvidenceBundleVerification,
  type EvidenceLedgerOptions,
  type EvidenceReadContext,
  type NormalizeSnapshotResult,
} from "./types.ts";
import { decodeUtf8, sliceUtf8 } from "./utf8.ts";

function bundleKey(normalizedDocumentId: string): string {
  if (!/^ndoc_[0-9a-f]{64}$/.test(normalizedDocumentId)) {
    throw new CoeContractError("invalid_contract", "Invalid normalized document ID");
  }
  return `records/normalizations/${normalizedDocumentId}.json`;
}

function expectedObjectKey(contentHash: string): string {
  const hex = contentHash.slice("sha256:".length);
  return `objects/sha256/${hex.slice(0, 2)}/${hex}`;
}

export class CoeEvidenceLedger {
  private readonly store: ContentAddressedStore;
  private readonly clock: () => Date;

  constructor(private readonly options: EvidenceLedgerOptions) {
    const nonce = options.nonce ?? (() => crypto.randomUUID());
    this.clock = options.clock ?? (() => new Date());
    this.store = new ContentAddressedStore(options.root, nonce);
  }

  async normalizeSnapshot(snapshotId: string, normalizer: DocumentNormalizer): Promise<NormalizeSnapshotResult> {
    const snapshot = await this.options.snapshotLedger.getCanonicalSnapshot(snapshotId);
    if (!normalizer.supports(snapshot.media_type)) {
      throw new CoeContractError(
        "policy_violation",
        `${normalizer.descriptor.name} does not support ${snapshot.media_type}`,
      );
    }
    const lockName = sha256Canonical({
      operation: "normalize",
      snapshot_id: snapshot.snapshot_id,
      normalizer: normalizer.descriptor,
    });
    return this.store.withLock(lockName, async () => {
      const rawBytes = await this.options.snapshotLedger.readSnapshotBytes(snapshot.snapshot_id);
      const output = await normalizer.normalize({ bytes: rawBytes, snapshot });
      const compiled = compileEvidenceBundle(snapshot, normalizer.descriptor, output, this.clock().toISOString());
      const document = compiled.bundle.normalized_document;
      const prior = await this.findBundleForNormalizer(snapshot.snapshot_id, normalizer);
      if (prior) {
        if (
          prior.normalized_document.normalized_document_id !== document.normalized_document_id ||
          prior.normalized_document.content_hash !== document.content_hash
        ) {
          throw new CoeContractError(
            "id_mismatch",
            "Normalizer output drift requires a new normalizer version or config hash",
          );
        }
        await this.verifyBundle(prior.normalized_document.normalized_document_id, normalizer);
        await this.options.projection.projectBundle(prior);
        return {
          outcome: "duplicate",
          normalized_document: prior.normalized_document,
          evidence_items: prior.evidence_items,
        };
      }

      const stored = await this.store.storeObject(compiled.normalized_bytes, document.content_hash);
      if (stored.object_key !== document.object_key || stored.byte_size !== document.byte_size) {
        throw new CoeContractError("hash_mismatch", "Normalized object does not match its canonical document");
      }
      await this.store.writeJsonOnce(bundleKey(document.normalized_document_id), compiled.bundle);
      await this.verifyBundle(document.normalized_document_id);
      await this.options.projection.projectBundle(compiled.bundle);
      return {
        outcome: "promoted",
        normalized_document: compiled.bundle.normalized_document,
        evidence_items: compiled.bundle.evidence_items,
      };
    });
  }

  async getCanonicalBundle(normalizedDocumentId: string): Promise<CanonicalEvidenceBundle> {
    const parsed = EvidenceBundleSchema.safeParse(await this.store.readJson(bundleKey(normalizedDocumentId)));
    if (!parsed.success) {
      throw new CoeContractError("invalid_contract", "Canonical evidence bundle failed validation");
    }
    if (parsed.data.normalized_document.normalized_document_id !== normalizedDocumentId) {
      throw new CoeContractError("id_mismatch", "Bundle path does not match normalized document ID");
    }
    return parsed.data;
  }

  async getCanonicalDocument(normalizedDocumentId: string): Promise<NormalizedDocumentContract> {
    return (await this.getCanonicalBundle(normalizedDocumentId)).normalized_document;
  }

  async readNormalizedText(normalizedDocumentId: string): Promise<string> {
    const document = await this.getCanonicalDocument(normalizedDocumentId);
    const bytes = await this.store.readObject(document.object_key, document.content_hash);
    if (bytes.byteLength !== document.byte_size) {
      throw new CoeContractError("hash_mismatch", "Normalized object byte size differs from its contract");
    }
    return decodeUtf8(bytes);
  }

  async getEvidenceForContext(
    evidenceId: string,
    context: EvidenceReadContext,
  ): Promise<EvidenceItemContract | null> {
    if (!/^evd_[0-9a-f]{64}$/.test(evidenceId)) return null;
    for (const key of await this.store.listKeys("records/normalizations")) {
      const bundle = await this.getCanonicalBundle(key.slice(key.lastIndexOf("/") + 1, -".json".length));
      const evidence = bundle.evidence_items.find(({ evidence_id }) => evidence_id === evidenceId);
      if (!evidence) continue;
      return canReadEvidenceScope(evidence.scope, context) ? evidence : null;
    }
    return null;
  }

  async verifyBundle(
    normalizedDocumentId: string,
    normalizer?: DocumentNormalizer,
  ): Promise<EvidenceBundleVerification> {
    const bundle = await this.getCanonicalBundle(normalizedDocumentId);
    const document = bundle.normalized_document;
    const snapshot = await this.options.snapshotLedger.getCanonicalSnapshot(document.snapshot_id);
    assertScopeDoesNotWiden(snapshot.scope, document.scope);
    if (document.object_key !== expectedObjectKey(document.content_hash)) {
      throw new CoeContractError("id_mismatch", "Normalized document object key does not match its content hash");
    }
    const expectedDocumentId = makeCoeId("ndoc", {
      snapshot_id: document.snapshot_id,
      content_hash: document.content_hash,
      normalizer: document.normalizer,
    });
    if (expectedDocumentId !== document.normalized_document_id) {
      throw new CoeContractError("id_mismatch", "Normalized document ID does not match its immutable identity");
    }
    const normalizedBytes = await this.store.readObject(document.object_key, document.content_hash);
    if (normalizedBytes.byteLength !== document.byte_size) {
      throw new CoeContractError("hash_mismatch", "Normalized document byte_size is not reproducible");
    }
    for (const section of document.sections) {
      const sectionText = sliceUtf8(normalizedBytes, section.normalized_span.start, section.normalized_span.end);
      if (sha256Bytes(sectionText) !== section.text_hash) {
        throw new CoeContractError("hash_mismatch", `Section ${section.section_id} text hash is invalid`);
      }
    }
    for (const mapping of document.mappings) {
      sliceUtf8(normalizedBytes, mapping.normalized_start, mapping.normalized_end);
    }
    for (const evidence of bundle.evidence_items) {
      assertScopeDoesNotWiden(document.scope, evidence.scope);
      const rebuilt = createEvidenceItem({
        document,
        normalized_bytes: normalizedBytes,
        section_id: evidence.section_id,
        normalized_span: evidence.normalized_span,
        evidence_type: evidence.evidence_type,
        created_at: evidence.created_at,
        expected_text: evidence.normalized_text,
      });
      if (canonicalizeJson(rebuilt) !== canonicalizeJson(evidence)) {
        throw new CoeContractError("id_mismatch", `Evidence ${evidence.evidence_id} is not reproducible`);
      }
    }

    let rawMappingVerified = false;
    if (normalizer) {
      if (canonicalizeJson(normalizer.descriptor) !== canonicalizeJson(document.normalizer)) {
        throw new CoeContractError("id_mismatch", "Normalizer descriptor does not match the canonical document");
      }
      const rawBytes = await this.options.snapshotLedger.readSnapshotBytes(snapshot.snapshot_id);
      const output = await normalizer.normalize({ bytes: rawBytes, snapshot });
      const rebuilt = compileEvidenceBundle(snapshot, normalizer.descriptor, output, document.created_at);
      if (
        !rebuilt.normalized_bytes.equals(Buffer.from(normalizedBytes)) ||
        canonicalizeJson(rebuilt.bundle) !== canonicalizeJson(bundle)
      ) {
        throw new CoeContractError("hash_mismatch", "Raw-to-normalized mapping drift detected");
      }
      rawMappingVerified = true;
    }

    return {
      normalized_document_id: document.normalized_document_id,
      evidence_items: bundle.evidence_items.length,
      mappings: document.mappings.length,
      sections: document.sections.length,
      raw_mapping_verified: rawMappingVerified,
    };
  }

  async rebuildProjection(): Promise<{ documents: number; evidence_items: number }> {
    let documents = 0;
    let evidenceItems = 0;
    for (const key of await this.store.listKeys("records/normalizations")) {
      if (!key.endsWith(".json")) continue;
      const id = key.slice(key.lastIndexOf("/") + 1, -".json".length);
      await this.verifyBundle(id);
      const bundle = await this.getCanonicalBundle(id);
      await this.options.projection.projectBundle(bundle);
      documents += 1;
      evidenceItems += bundle.evidence_items.length;
    }
    return { documents, evidence_items: evidenceItems };
  }

  private async findBundleForNormalizer(
    snapshotId: string,
    normalizer: DocumentNormalizer,
  ): Promise<CanonicalEvidenceBundle | null> {
    for (const key of await this.store.listKeys("records/normalizations")) {
      if (!key.endsWith(".json")) continue;
      const id = key.slice(key.lastIndexOf("/") + 1, -".json".length);
      const bundle = await this.getCanonicalBundle(id);
      if (
        bundle.normalized_document.snapshot_id === snapshotId &&
        canonicalizeJson(bundle.normalized_document.normalizer) === canonicalizeJson(normalizer.descriptor)
      ) {
        return bundle;
      }
    }
    return null;
  }
}
