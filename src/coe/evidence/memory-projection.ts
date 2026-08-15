import {
  CoeContractError,
  canonicalizeJson,
  type EvidenceItemContract,
  type NormalizedDocumentContract,
} from "../contracts/index.ts";
import {
  EvidenceBundleSchema,
  type CanonicalEvidenceBundle,
  type CoeEvidenceProjection,
} from "./types.ts";

export class InMemoryCoeEvidenceProjection implements CoeEvidenceProjection {
  readonly documents = new Map<string, NormalizedDocumentContract>();
  readonly evidence = new Map<string, EvidenceItemContract>();
  private readonly bundles = new Map<string, string>();

  async projectBundle(bundle: CanonicalEvidenceBundle): Promise<void> {
    const parsed = EvidenceBundleSchema.safeParse(bundle);
    if (!parsed.success) {
      throw new CoeContractError("invalid_contract", "Evidence projection rejected an invalid canonical bundle");
    }
    const canonicalBundle = parsed.data;
    const document = canonicalBundle.normalized_document;
    const bundleJson = canonicalizeJson(canonicalBundle);
    const existingBundle = this.bundles.get(document.normalized_document_id);
    if (existingBundle && existingBundle !== bundleJson) {
      throw new CoeContractError("id_mismatch", "Normalized-document bundle ID maps to different content");
    }
    const existingDocument = this.documents.get(document.normalized_document_id);
    if (existingDocument && canonicalizeJson(existingDocument) !== canonicalizeJson(document)) {
      throw new CoeContractError("id_mismatch", "Normalized document ID maps to different content");
    }
    for (const item of canonicalBundle.evidence_items) {
      const existing = this.evidence.get(item.evidence_id);
      if (existing && canonicalizeJson(existing) !== canonicalizeJson(item)) {
        throw new CoeContractError("id_mismatch", "Evidence ID maps to different content");
      }
    }

    if (!existingBundle) this.bundles.set(document.normalized_document_id, bundleJson);
    if (!existingDocument) this.documents.set(document.normalized_document_id, structuredClone(document));
    for (const item of canonicalBundle.evidence_items) {
      if (!this.evidence.has(item.evidence_id)) this.evidence.set(item.evidence_id, structuredClone(item));
    }
  }

  clear(): void {
    this.bundles.clear();
    this.documents.clear();
    this.evidence.clear();
  }
}
