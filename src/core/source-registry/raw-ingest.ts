import { createHash } from 'crypto';
import { estimateTokenCount } from '../token-count.ts';

export type SourceOriginEvent =
  | 'initial_import'
  | 'connector_sync'
  | 'manual_entry'
  | 'user_direct_entry'
  | 'session_capture'
  | 'markdown_edit';

export type PromptInjectionRisk = 'none' | 'flagged' | 'quarantined';
export type SecretRisk = 'none' | 'flagged' | 'detected' | 'redacted';

export interface RawIngestPolicy {
  consent_state: string;
  enabled: boolean;
  raw_copy_mode: string;
  automatic_canonical_write_authority: string;
}

export interface RawIngestInput {
  source_id: string;
  external_id: string;
  origin_event: SourceOriginEvent;
  locator?: string | null;
  title?: string;
  chunk_texts: string[];
  parser_version: string;
  extractor_version?: string;
  now?: string;
  expires_at?: string | null;
  requested_raw_copy?: boolean;
  raw_text?: string;
}

export interface SourceItemRecord {
  id: string;
  source_id: string;
  external_id: string;
  origin_event: SourceOriginEvent;
  locator: string | null;
  title: string;
  source_created_at: string | null;
  source_updated_at: string | null;
  ingested_at: string;
  content_hash: string;
  metadata_json: Record<string, unknown>;
  raw_copy_mode: string;
  raw_copy_ref: string | null;
  sensitivity_level: string;
  ingest_status: 'pending' | 'ready' | 'failed' | 'revoked' | 'purged';
  retention_policy_id: string | null;
}

export interface SourceChunkRecord {
  id: string;
  source_item_id: string;
  chunk_index: number;
  chunk_hash: string;
  chunk_text: string;
  redacted_text: string;
  token_count: number;
  parser_version: string;
  extractor_version: string;
  sensitivity_flags: string[];
  prompt_injection_risk: PromptInjectionRisk;
  secret_risk: SecretRisk;
  created_at: string;
  expires_at: string | null;
}

export interface SecretDetectionRecord {
  id: string;
  source_item_id: string;
  source_chunk_id: string;
  secret_type: string;
  secret_hash: string;
  confidence: number;
  redaction_status: 'redacted';
  purge_plan_status: 'pending';
  created_at: string;
}

export interface PromptInjectionFlagRecord {
  id: string;
  source_item_id: string;
  source_chunk_id: string;
  flag_type: string;
  risk: Exclude<PromptInjectionRisk, 'none'>;
  evidence_hash: string;
  created_at: string;
}

export interface SourceItemEventRecord {
  id: string;
  source_item_id: string;
  event_type: string;
  created_at: string;
}

export interface RawIngestPlan {
  item: SourceItemRecord;
  chunks: SourceChunkRecord[];
  events: SourceItemEventRecord[];
  secret_detections: SecretDetectionRecord[];
  prompt_injection_flags: PromptInjectionFlagRecord[];
}

export interface RawCopyStorageDecision {
  store_full_raw_copy: boolean;
  raw_copy_ref: string | null;
  denial_reason: string | null;
}

export interface AutoWriteDecision {
  allowed: boolean;
  reason: string;
}

export interface RunnerChunkPayload {
  chunk_id: string;
  text: string;
  redacted: boolean;
  sensitivity_flags: string[];
}

const INVISIBLE_FORMAT_TEXT_PATTERN = /[\u00AD\u034F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const PROMPT_INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|earlier|above|system|developer)\s+(?:instructions?|prompts?|messages?|rules?)\b/,
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|earlier|above)\s+(?:system|developer)\s+(?:instructions?|prompts?|messages?|rules?)\b/,
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions?)\b/,
  /\b(?:reveal|show|print|display|dump|leak|exfiltrat\w*|send|share|return)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions?)\b/,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|jailbreak|admin|root)\s+mode\b/,
  /\b(?:exfiltrat\w*|tool misuse|remote command)\b/,
];
const SECRET_PATTERNS: Array<{
  type: string;
  pattern: RegExp;
  replacement?: (secret: string) => string;
}> = [
  {
    type: 'database_connection_string',
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:[^@\s]+@/gi,
    replacement: (secret) => `${secret.slice(0, secret.indexOf('://') + 3)}[REDACTED:database_connection_string]@`,
  },
  {
    type: 'pem_private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    type: 'anthropic_api_key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  },
  {
    type: 'openai_api_key',
    pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  },
  {
    type: 'github_token',
    pattern: /\b(?:gh[opsru]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
  },
  {
    type: 'slack_token',
    pattern: /\bxox[baprs]-(?:\d{10,}-)?[A-Za-z0-9-]{24,}\b/g,
  },
  {
    type: 'aws_access_key_id',
    pattern: /\bA[KS]IA[0-9A-Z]{16}\b/g,
  },
  {
    type: 'aws_secret_access_key',
    pattern: /\baws[ _-]?secret[ _-]?access[ _-]?key\s*[:=]\s*(['"]?)[A-Za-z0-9/+=]{40}\1(?=$|[^A-Za-z0-9/+=])/gi,
    replacement: (secret) => `${secret.slice(0, secret.search(/[:=]/) + 1)}[REDACTED:aws_secret_access_key]`,
  },
];

export function buildRawIngestPlan(input: RawIngestInput, policy: RawIngestPolicy): RawIngestPlan {
  assertIngestAllowed(policy);
  const now = input.now ?? new Date().toISOString();
  const rawText = input.raw_text ?? input.chunk_texts.join('\n\n');
  const itemId = stableId('source-item', input.source_id, input.external_id);
  const rawCopy = decideRawCopyStorage({
    requested_raw_copy: input.requested_raw_copy ?? false,
    raw_text: rawText,
    policy,
  });

  const item: SourceItemRecord = {
    id: itemId,
    source_id: input.source_id,
    external_id: input.external_id,
    origin_event: input.origin_event,
    locator: input.locator ?? null,
    title: input.title ?? '',
    source_created_at: null,
    source_updated_at: null,
    ingested_at: now,
    content_hash: sha256(rawText),
    metadata_json: {},
    raw_copy_mode: policy.raw_copy_mode,
    raw_copy_ref: rawCopy.raw_copy_ref,
    sensitivity_level: 'normal',
    ingest_status: 'ready',
    retention_policy_id: null,
  };

  const secretDetections: SecretDetectionRecord[] = [];
  const promptInjectionFlags: PromptInjectionFlagRecord[] = [];
  const chunks = input.chunk_texts.map((chunkText, chunkIndex) => {
    const chunkId = stableId('source-chunk', itemId, String(chunkIndex), chunkText);
    const promptInjectionRisk = classifyPromptInjection(chunkText);
    const redaction = redactSecrets(chunkText);
    const sensitivityFlags = [
      ...(promptInjectionRisk === 'none' ? [] : ['prompt_injection']),
      ...(redaction.secretDetections.length === 0 ? [] : ['secret']),
    ];

    const chunk: SourceChunkRecord = {
      id: chunkId,
      source_item_id: itemId,
      chunk_index: chunkIndex,
      chunk_hash: sha256(chunkText),
      chunk_text: chunkText,
      redacted_text: redaction.text,
      token_count: estimateTokenCount(chunkText),
      parser_version: input.parser_version,
      extractor_version: input.extractor_version ?? '',
      sensitivity_flags: sensitivityFlags,
      prompt_injection_risk: promptInjectionRisk,
      secret_risk: redaction.secretDetections.length === 0 ? 'none' : 'redacted',
      created_at: now,
      expires_at: input.expires_at ?? null,
    };

    for (const detection of redaction.secretDetections) {
      secretDetections.push({
        id: stableId('secret-detection', chunkId, detection.secret_hash),
        source_item_id: itemId,
        source_chunk_id: chunkId,
        secret_type: detection.secret_type,
        secret_hash: detection.secret_hash,
        confidence: detection.confidence,
        redaction_status: 'redacted',
        purge_plan_status: 'pending',
        created_at: now,
      });
    }

    if (promptInjectionRisk !== 'none') {
      promptInjectionFlags.push({
        id: stableId('prompt-injection', chunkId, promptInjectionRisk),
        source_item_id: itemId,
        source_chunk_id: chunkId,
        flag_type: 'instruction_override',
        risk: promptInjectionRisk,
        evidence_hash: sha256(chunkText),
        created_at: now,
      });
    }

    return chunk;
  });

  return {
    item,
    chunks,
    events: [{
      id: stableId('source-item-event', itemId, 'ingested'),
      source_item_id: itemId,
      event_type: 'ingested',
      created_at: now,
    }],
    secret_detections: secretDetections,
    prompt_injection_flags: promptInjectionFlags,
  };
}

export function decideRawCopyStorage(input: {
  requested_raw_copy: boolean;
  raw_text: string;
  policy: Pick<RawIngestPolicy, 'raw_copy_mode'>;
}): RawCopyStorageDecision {
  if (!input.requested_raw_copy) {
    return { store_full_raw_copy: false, raw_copy_ref: null, denial_reason: null };
  }
  if (normalizeRawCopyMode(input.policy.raw_copy_mode) !== 'full') {
    return {
      store_full_raw_copy: false,
      raw_copy_ref: null,
      denial_reason: 'policy_denies_full_raw_copy',
    };
  }
  return {
    store_full_raw_copy: true,
    raw_copy_ref: `raw-copy:${sha256(input.raw_text)}`,
    denial_reason: null,
  };
}

export function canChunkAutoWrite(
  chunk: Pick<SourceChunkRecord, 'prompt_injection_risk' | 'secret_risk'>,
  policy: Pick<RawIngestPolicy, 'automatic_canonical_write_authority'>,
): AutoWriteDecision {
  if (chunk.prompt_injection_risk !== 'none') {
    return { allowed: false, reason: 'prompt_injection_flagged' };
  }
  if (chunk.secret_risk !== 'none') {
    return { allowed: false, reason: 'secret_detected' };
  }
  if (policy.automatic_canonical_write_authority.includes('candidate')) {
    return { allowed: false, reason: 'policy_routes_to_candidate' };
  }
  return { allowed: true, reason: 'policy_allows_auto_write' };
}

export function buildRunnerChunkPayload(chunk: SourceChunkRecord): RunnerChunkPayload {
  return {
    chunk_id: chunk.id,
    text: chunk.redacted_text,
    redacted: chunk.redacted_text !== chunk.chunk_text,
    sensitivity_flags: [...chunk.sensitivity_flags],
  };
}

function assertIngestAllowed(policy: RawIngestPolicy): void {
  if (policy.consent_state !== 'granted') {
    throw new Error(`source consent ${policy.consent_state} prevents ingest`);
  }
  if (!policy.enabled) {
    throw new Error('disabled source prevents ingest');
  }
}

function classifyPromptInjection(text: string): PromptInjectionRisk {
  const detectionText = normalizePromptInjectionText(text);
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(detectionText)) ? 'flagged' : 'none';
}

function normalizePromptInjectionText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE_FORMAT_TEXT_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function redactSecrets(text: string): {
  text: string;
  secretDetections: Array<{ secret_type: string; secret_hash: string; confidence: number }>;
} {
  const detections: Array<{ secret_type: string; secret_hash: string; confidence: number }> = [];
  let redacted = text;
  for (const secretPattern of SECRET_PATTERNS) {
    redacted = redacted.replace(secretPattern.pattern, (secret) => {
      detections.push({
        secret_type: secretPattern.type,
        secret_hash: sha256(secret),
        confidence: 0.99,
      });
      return secretPattern.replacement?.(secret) ?? `[REDACTED:${secretPattern.type}]`;
    });
  }
  return { text: redacted, secretDetections: detections };
}

function normalizeRawCopyMode(value: string): string {
  return value.replace(/\+/g, '_').replace(/-/g, '_');
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${sha256(parts.join('\0')).slice(0, 24)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
