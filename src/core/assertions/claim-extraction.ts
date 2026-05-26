import {
  isAssertionClaimType,
  stableId,
  type AssertionClaimType,
  type ExtractedClaim,
  type JsonValue,
} from './assertion-types.ts';

export interface SourceChunkClaimInput {
  source_id: string;
  source_item_id: string;
  source_chunk_id: string;
  chunk_text: string;
  extractor_kind: string;
  extractor_version: string;
  runner_job_id?: string | null;
  claim_type: AssertionClaimType | string;
  target_hint: string;
  property_hint: string;
  value: JsonValue;
  claim_text?: string;
  confidence: number;
  sensitivity_level?: string;
  prompt_injection_flag?: boolean;
  secret_flag?: boolean;
  valid_from?: string | null;
  valid_until?: string | null;
  now?: string;
}

export function buildExtractedClaim(input: SourceChunkClaimInput): ExtractedClaim {
  assertClaimType(input.claim_type);
  assertConfidence(input.confidence);
  const createdAt = input.now ?? new Date().toISOString();
  const claimText = input.claim_text ?? input.chunk_text;
  return {
    id: stableId(
      'extracted-claim',
      input.source_chunk_id,
      input.extractor_kind,
      input.extractor_version,
      input.claim_type,
      input.target_hint,
      input.property_hint,
      JSON.stringify(input.value),
    ),
    source_id: input.source_id,
    source_item_id: input.source_item_id,
    source_chunk_id: input.source_chunk_id,
    extractor_kind: input.extractor_kind,
    extractor_version: input.extractor_version,
    runner_job_id: input.runner_job_id ?? null,
    claim_text: claimText,
    claim_type: input.claim_type,
    target_hint: input.target_hint,
    property_hint: input.property_hint,
    value_json: input.value,
    confidence: input.confidence,
    sensitivity_level: input.sensitivity_level ?? 'normal',
    prompt_injection_flag: input.prompt_injection_flag ?? false,
    secret_flag: input.secret_flag ?? false,
    status: 'pending_resolution',
    valid_from: input.valid_from ?? null,
    valid_until: input.valid_until ?? null,
    created_at: createdAt,
  };
}

export const createExtractedClaimFromSourceChunk = buildExtractedClaim;

function assertClaimType(value: string): asserts value is AssertionClaimType {
  if (!isAssertionClaimType(value)) {
    throw new Error(`unsupported claim_type: ${value}`);
  }
}

function assertConfidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('confidence must be between 0 and 1');
  }
}
