export type MemoryType = 'person' | 'company' | 'project' | 'concept' | 'meeting';

export interface MemoryNode {
  id: string;
  slug: string;
  type: MemoryType;
  title: string;
  summary: string;
  source: string;
  confidence: number;
  consent: boolean;
  created_at: string;
  last_verified_at: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface Relation {
  from_slug: string;
  to_slug: string;
  relation_type: string;
  confidence: number;
  context: string;
  source: string;
  created_at: string;
}

export interface VoiceSession {
  id: string;
  transcript: string;
  answer: string;
  summary: string;
  tags: string[];
  source: string;
  consent: boolean;
  confidence: number;
  created_at: string;
  duration_ms: number;
  page_slug?: string;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const VALID_MEMORY_TYPES: ReadonlySet<string> = new Set(['person', 'company', 'project', 'concept', 'meeting']);

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string, got ${typeof value}`);
  }
  if (value.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertString(value, field);
}

function assertNumber(value: unknown, field: string, min?: number, max?: number): number {
  if (typeof value !== 'number' || !isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number, got ${typeof value}`);
  }
  if (min !== undefined && value < min) {
    throw new ValidationError(`${field} must be >= ${min}, got ${value}`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`${field} must be <= ${max}, got ${value}`);
  }
  return value;
}

function assertConfidence(value: unknown, field: string): number {
  const n = assertNumber(value, field);
  if (n < 0 || n > 1) {
    throw new ValidationError(`${field} must be between 0 and 1, got ${n}`);
  }
  return n;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean, got ${typeof value}`);
  }
  return value;
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array, got ${typeof value}`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ValidationError(`${field} must be an array of strings, got ${typeof item}`);
    }
  }
  return value;
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${field} must be a non-null object`);
  }
  return value as Record<string, unknown>;
}

function assertMemoryType(value: unknown, field: string): MemoryType {
  const s = assertString(value, field);
  if (!VALID_MEMORY_TYPES.has(s)) {
    throw new ValidationError(`${field} must be one of ${[...VALID_MEMORY_TYPES].join(', ')}, got "${s}"`);
  }
  return s as MemoryType;
}

function assertIsoDate(value: unknown, field: string): string {
  const s = assertString(value, field);
  if (isNaN(Date.parse(s))) {
    throw new ValidationError(`${field} must be a valid ISO date string, got "${s}"`);
  }
  return s;
}

export function validateMemoryNode(data: unknown): MemoryNode {
  const d = assertRecord(data, 'data');
  return {
    id: assertString(d.id, 'id'),
    slug: assertString(d.slug, 'slug'),
    type: assertMemoryType(d.type, 'type'),
    title: assertString(d.title, 'title'),
    summary: assertString(d.summary, 'summary'),
    source: assertString(d.source, 'source'),
    confidence: assertConfidence(d.confidence, 'confidence'),
    consent: assertBoolean(d.consent, 'consent'),
    created_at: assertIsoDate(d.created_at, 'created_at'),
    last_verified_at: assertIsoDate(d.last_verified_at, 'last_verified_at'),
    tags: assertStringArray(d.tags, 'tags'),
    metadata: assertRecord(d.metadata, 'metadata'),
  };
}

export function validateRelation(data: unknown): Relation {
  const d = assertRecord(data, 'data');
  return {
    from_slug: assertString(d.from_slug, 'from_slug'),
    to_slug: assertString(d.to_slug, 'to_slug'),
    relation_type: assertString(d.relation_type, 'relation_type'),
    confidence: assertConfidence(d.confidence, 'confidence'),
    context: assertString(d.context, 'context'),
    source: assertString(d.source, 'source'),
    created_at: assertIsoDate(d.created_at, 'created_at'),
  };
}

export function validateVoiceSession(data: unknown): VoiceSession {
  const d = assertRecord(data, 'data');
  return {
    id: assertString(d.id, 'id'),
    transcript: assertString(d.transcript, 'transcript'),
    answer: assertString(d.answer, 'answer'),
    summary: assertString(d.summary, 'summary'),
    tags: assertStringArray(d.tags, 'tags'),
    source: assertString(d.source, 'source'),
    consent: assertBoolean(d.consent, 'consent'),
    confidence: assertConfidence(d.confidence, 'confidence'),
    created_at: assertIsoDate(d.created_at, 'created_at'),
    duration_ms: assertNumber(d.duration_ms, 'duration_ms', 0),
    page_slug: assertOptionalString(d.page_slug, 'page_slug'),
  };
}
