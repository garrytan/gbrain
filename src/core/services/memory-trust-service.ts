import type {
  MemoryCandidateExtractionKind,
  MemoryCandidateGeneratedBy,
  MemoryCandidateVerificationStatus,
  MemoryWritebackEvidenceKind,
  SourceTrustTier,
} from '../types.ts';

/**
 * Source trust tiers + instruction-injection lint (N-8).
 *
 * Everything in this module is deterministic and disclosure-oriented: the tier
 * mapping annotates retrieval results and reads so agents can see how strong
 * the provenance behind a piece of memory is, and the lint flags
 * instruction-shaped content in memory-candidate bodies. Neither output is
 * consumed by ranking (ranking consumption stays behind the EV-1b gate).
 */

/** Strongest-first ordering; lower index = stronger trust. */
export const SOURCE_TRUST_TIER_ORDER: readonly SourceTrustTier[] = [
  'user_direct',
  'verified_doc',
  'extracted',
  'imported',
  'unattributed',
];

const EVIDENCE_KIND_VALUES: readonly MemoryWritebackEvidenceKind[] = [
  'direct_user_statement',
  'source_extracted',
  'agent_inferred',
  'ambiguous',
  'contradicts_existing',
  'code_sensitive',
  'task_mechanics',
];

/**
 * Evidence-kind mapping (checked first when classifying):
 * - direct_user_statement -> user_direct (the user said it directly)
 * - source_extracted      -> extracted   (pulled from an attributed source)
 * - agent_inferred        -> unattributed (agent's own inference, no source authority)
 * - ambiguous             -> unattributed
 * - contradicts_existing  -> unattributed (contested claims carry no source trust)
 * - code_sensitive        -> extracted   (grounded in code that can be re-checked)
 * - task_mechanics        -> unattributed (transient mechanics, no durable source)
 */
export function sourceTrustTierForEvidenceKind(kind: MemoryWritebackEvidenceKind): SourceTrustTier {
  switch (kind) {
    case 'direct_user_statement':
      return 'user_direct';
    case 'source_extracted':
    case 'code_sensitive':
      return 'extracted';
    case 'agent_inferred':
    case 'ambiguous':
    case 'contradicts_existing':
    case 'task_mechanics':
      return 'unattributed';
    default:
      return assertNeverEvidenceKind(kind);
  }
}

function assertNeverEvidenceKind(kind: never): never {
  throw new Error(`Unhandled memory writeback evidence kind: ${kind}`);
}

const USER_DIRECT_REF_PATTERN = /\buser\s*,?\s*(?:direct\s+(?:message|statement)|dm\b)/i;
const USER_REF_PREFIX_PATTERN = /^(?:source:\s*)?user\s*[,:]/i;
const VERIFIED_REF_PATTERN = /^(?:source:\s*)?verif(?:ied|ication)\s*[,:]/i;
const URL_REF_PATTERN = /(?:^url:|https?:\/\/)/i;
const IMPORT_PIPELINE_REF_PATTERN = /^(?:source_item|source_chunk):/i;
const WEB_REF_PATTERN = /\bweb\b/i;

/**
 * Source-ref shape heuristics, first match wins:
 * 1. user_direct  - "User, direct message, ..." style attributions, `user:`/`User,` prefixes.
 * 2. verified_doc - refs recorded by an explicit verification step (`verification:` / `Verified,` prefixes).
 * 3. imported     - URLs / `url:` refs, the word "web", and raw import-pipeline refs
 *                   (`source_item:` / `source_chunk:` from connectors, meetings, session ingest).
 * 4. extracted    - any other non-empty attribution (named-source citations, file paths, session refs).
 * 5. unattributed - empty/whitespace refs.
 */
export function sourceTrustTierForSourceRef(ref: string): SourceTrustTier {
  const trimmed = typeof ref === 'string' ? ref.trim() : '';
  if (trimmed.length === 0) return 'unattributed';
  if (USER_DIRECT_REF_PATTERN.test(trimmed) || USER_REF_PREFIX_PATTERN.test(trimmed)) {
    return 'user_direct';
  }
  if (VERIFIED_REF_PATTERN.test(trimmed)) return 'verified_doc';
  if (
    URL_REF_PATTERN.test(trimmed)
    || IMPORT_PIPELINE_REF_PATTERN.test(trimmed)
    || WEB_REF_PATTERN.test(trimmed)
  ) {
    return 'imported';
  }
  return 'extracted';
}

/** Strongest tier across refs; 'unattributed' when no non-empty ref exists. */
export function sourceTrustTierForSourceRefs(refs: readonly string[]): SourceTrustTier {
  return strongestSourceTrustTier(refs.map((ref) => sourceTrustTierForSourceRef(ref)));
}

export function strongestSourceTrustTier(tiers: readonly SourceTrustTier[]): SourceTrustTier {
  let strongestIndex = SOURCE_TRUST_TIER_ORDER.length - 1;
  for (const tier of tiers) {
    const index = SOURCE_TRUST_TIER_ORDER.indexOf(tier);
    if (index >= 0 && index < strongestIndex) strongestIndex = index;
  }
  return SOURCE_TRUST_TIER_ORDER[strongestIndex]!;
}

function weakerSourceTrustTier(a: SourceTrustTier, b: SourceTrustTier): SourceTrustTier {
  return SOURCE_TRUST_TIER_ORDER.indexOf(a) >= SOURCE_TRUST_TIER_ORDER.indexOf(b) ? a : b;
}

export interface SourceTrustCandidateInput {
  source_refs: readonly string[];
  extraction_kind?: MemoryCandidateExtractionKind;
  generated_by?: MemoryCandidateGeneratedBy;
  verification_status?: MemoryCandidateVerificationStatus;
}

/**
 * Candidate mapping, applied in order:
 * 1. Base tier = strongest tier across source_refs (unattributed when none).
 * 2. extraction_kind 'inferred'/'ambiguous' caps the base at 'unattributed'
 *    (mirrors the agent_inferred/ambiguous evidence kinds).
 * 3. generated_by 'import' caps the base at 'imported'.
 * 4. verification_status 'verified' raises the result to at least
 *    'verified_doc' (an explicit verification record outranks the caps).
 * 5. verification_status 'refuted' forces 'unattributed'.
 */
export function sourceTrustTierForCandidate(candidate: SourceTrustCandidateInput): SourceTrustTier {
  if (candidate.verification_status === 'refuted') return 'unattributed';
  let tier = sourceTrustTierForSourceRefs(candidate.source_refs);
  if (candidate.extraction_kind === 'inferred' || candidate.extraction_kind === 'ambiguous') {
    tier = 'unattributed';
  }
  if (candidate.generated_by === 'import') {
    tier = weakerSourceTrustTier(tier, 'imported');
  }
  if (candidate.verification_status === 'verified') {
    tier = strongestSourceTrustTier([tier, 'verified_doc']);
  }
  return tier;
}

/**
 * Dispatching classifier: evidence kinds first, then source-ref shape
 * heuristics for strings, and the candidate mapping for objects.
 */
export function sourceTrustTier(
  input: string | MemoryWritebackEvidenceKind | SourceTrustCandidateInput,
): SourceTrustTier {
  if (typeof input === 'string') {
    if ((EVIDENCE_KIND_VALUES as readonly string[]).includes(input)) {
      return sourceTrustTierForEvidenceKind(input as MemoryWritebackEvidenceKind);
    }
    return sourceTrustTierForSourceRef(input);
  }
  return sourceTrustTierForCandidate(input);
}

export interface InstructionInjectionLintResult {
  flagged: boolean;
  reasons: string[];
}

export const INSTRUCTION_INJECTION_REVIEW_REASON_PREFIX = 'instruction_injection_flagged';

const MIN_BASE64_BLOCK_LENGTH = 200;

/**
 * Conservative, documented instruction-injection patterns. Each entry pairs a
 * stable reason id with the regex that triggers it. Normal imperative prose
 * ("run bun test", "update the page") must not match; the patterns target
 * content that tries to steer an agent rather than inform it.
 */
const INSTRUCTION_INJECTION_PATTERNS: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  {
    // "ignore all previous instructions", "disregard prior rules", ...
    reason: 'override_previous_instructions',
    pattern: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|rules?|prompts?|messages?|directives?)\b/i,
  },
  {
    // "disregard the system prompt", "reveal the developer instructions", ...
    reason: 'system_prompt_override',
    pattern: /\b(?:ignore|disregard|forget|override|bypass|reveal|show|print|dump|leak|exfiltrate)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  },
  {
    // "you must now ...": imperative re-tasking of the reading agent.
    reason: 'assistant_role_hijack',
    pattern: /\byou\s+must\s+now\b/i,
  },
  {
    // "act as ..." only in the privileged/role-hijack form; plain prose like
    // "the service acts as a proxy" must not match.
    reason: 'assistant_role_hijack',
    pattern: /\b(?:you\s+are\s+now|(?:now\s+)?act\s+as)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:system|developer|admin|root|jailbroken|unrestricted|dan)\b/i,
  },
  {
    // Tool-invocation JSON blobs embedded in memory content.
    reason: 'tool_invocation_blob',
    pattern: /"(?:tool_use|tool_calls|tool_name|function_call)"\s*:/,
  },
  {
    // Tool-call markup fragments.
    reason: 'tool_invocation_blob',
    pattern: /<\/?(?:tool_call|function_call|antml:invoke)\b/i,
  },
  {
    // Opaque base64-looking payloads long enough to smuggle instructions.
    reason: 'base64_block',
    pattern: new RegExp(`[A-Za-z0-9+/]{${MIN_BASE64_BLOCK_LENGTH},}={0,2}`),
  },
  {
    // KO: "이전 지시(사항) 무시", "기존 규칙 무시", ...
    reason: 'override_previous_instructions_ko',
    pattern: /(?:이전|기존|위|앞선?)\s*(?:지시|명령|규칙|프롬프트)(?:\s*사항)?[^\n]{0,12}무시/,
  },
  {
    // KO: "시스템 프롬프트 무시/공개/유출/출력" — requires an override or
    // exfiltration verb nearby so a plain mention does not flag.
    reason: 'system_prompt_override_ko',
    pattern: /시스템\s*프롬프트[^\n]{0,20}(?:무시|공개|유출|출력|보여|알려)/,
  },
];

/**
 * Deterministic lint for instruction-shaped content in memory bodies.
 * Flagged content is never blocked from capture; downstream governance forces
 * captured status and denies promotion until verification (see
 * memory-inbox-service.ts).
 */
export function lintInstructionInjection(text: string): InstructionInjectionLintResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { flagged: false, reasons: [] };
  }
  const reasons: string[] = [];
  for (const { reason, pattern } of INSTRUCTION_INJECTION_PATTERNS) {
    if (reasons.includes(reason)) continue;
    if (pattern.test(text)) reasons.push(reason);
  }
  return { flagged: reasons.length > 0, reasons };
}

/** Formats the appended review reason: `instruction_injection_flagged:<r1,r2>`. */
export function instructionInjectionReviewReason(reasons: readonly string[]): string {
  return `${INSTRUCTION_INJECTION_REVIEW_REASON_PREFIX}:${reasons.join(',')}`;
}

export function reviewReasonHasInstructionInjectionFlag(reviewReason: string | null | undefined): boolean {
  return typeof reviewReason === 'string'
    && reviewReason.includes(INSTRUCTION_INJECTION_REVIEW_REASON_PREFIX);
}
