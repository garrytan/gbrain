import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine, FileRow } from './engine.ts';

export type UnitKind = 'document' | 'page' | 'frame' | 'segment';
export type VisualKind = 'text' | 'scan' | 'image' | 'mixed' | 'unknown';
export type Risk = 'pass' | 'warning' | 'visual_review_required' | 'hard_failure';
export type PlatformReason =
  | 'DB_SOURCE_FILE_MISSING' | 'DB_SOURCE_HASH_MISMATCH' | 'DB_SOURCE_MIME_MISMATCH'
  | 'PHYSICAL_SOURCE_HASH_MISMATCH' | 'PHYSICAL_SOURCE_UNAVAILABLE' | 'COVERAGE_INVALID'
  | 'COVERAGE_LOSS' | 'MAPPING_MISSING' | 'UNREADABLE_REGION' | 'VISUAL_CANDIDATE'
  | 'CONFIDENCE_BELOW_POLICY' | 'CONVERTER_WARNING' | 'OBSERVATION_INCOMPLETE'
  | 'UNSUPPORTED_MANIFEST_VERSION';
export type ByteCheckReason = 'not_requested' | 'remote_caller' | 'checked_match' | 'checked_mismatch' | 'unavailable' | 'read_error';
export type DocumentRange = { kind: 'document' };
export type OrdinalRange = { kind: 'ordinal'; unitKind: Exclude<UnitKind, 'document'>; start: number; end: number };
export type TimeRange = { kind: 'time_ms'; start: number; end: number };
export type ConversionRange = DocumentRange | OrdinalRange | TimeRange;
export type ByteCheck = { reason: ByteCheckReason; reasons: readonly [] };
export type ConversionManifestErrorCode = 'invalid_params' | 'invalid_source_hash' | 'invalid_source_mime' | 'invalid_source_file' | 'idempotency_conflict' | 'permission_denied';

export class ConversionManifestError extends Error {
  readonly code: ConversionManifestErrorCode;
  constructor(code: ConversionManifestErrorCode, message: string) {
    super(message); this.name = 'ConversionManifestError'; this.code = code;
  }
}
const fail = (message: string, code: ConversionManifestErrorCode = 'invalid_params'): never => { throw new ConversionManifestError(code, message); };
const units = new Set<UnitKind>(['document', 'page', 'frame', 'segment']);
const visuals = new Set<VisualKind>(['text', 'scan', 'image', 'mixed', 'unknown']);
const reasons = new Set<PlatformReason>(['DB_SOURCE_FILE_MISSING', 'DB_SOURCE_HASH_MISMATCH', 'DB_SOURCE_MIME_MISMATCH', 'PHYSICAL_SOURCE_HASH_MISMATCH', 'PHYSICAL_SOURCE_UNAVAILABLE', 'COVERAGE_INVALID', 'COVERAGE_LOSS', 'MAPPING_MISSING', 'UNREADABLE_REGION', 'VISUAL_CANDIDATE', 'CONFIDENCE_BELOW_POLICY', 'CONVERTER_WARNING', 'OBSERVATION_INCOMPLETE', 'UNSUPPORTED_MANIFEST_VERSION']);
const IDENTITY_FIELDS = ['adapterKind', 'converter', 'converterVersion', 'model', 'modelVersion'] as const;
type IdentityField = typeof IDENTITY_FIELDS[number];
const identityCredential = /\b(?:authorization|bearer|basic|cookie|password|passwd|token|secret|api[_-]?key|credential|private[_-]?key)\b\s*[:=]|\b(?:bearer|basic)\s+\S+|\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|\\\\[^\\]+\\[^\\]+|\b(?:sk|gh[opsu]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b|^eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i;
const sanitizeIdentity = (value: unknown, name: IdentityField): string | null => {
  if ((value === null || value === undefined) && (name === 'model' || name === 'modelVersion')) return null;
  if (typeof value !== 'string') return fail(`invalid ${name}`);
  if (value.length === 0 || value.length > (name === 'adapterKind' ? 64 : 128)) fail(`invalid ${name}`);
  if (identityCredential.test(value) || sanitizeEvidenceText(value) !== value) fail(`invalid ${name}`);
  return value;
};
const sanitizeIdentities = (input: Record<string, unknown>): Record<IdentityField, string | null> => ({
  adapterKind: sanitizeIdentity(input.adapterKind, 'adapterKind') as string,
  converter: sanitizeIdentity(input.converter, 'converter') as string,
  converterVersion: sanitizeIdentity(input.converterVersion, 'converterVersion') as string,
  model: sanitizeIdentity(input.model, 'model'),
  modelVersion: sanitizeIdentity(input.modelVersion, 'modelVersion'),
});
const safeInt = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ConversionManifestError('invalid_params', `${name} must be a non-negative safe integer`);
  }
  return value;
};
const plain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const keysExactly = (value: Record<string, unknown>, allowed: readonly string[], name: string) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown ${name} key`);
};
const nullableProbability = (value: unknown, name: string): number | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(`invalid ${name}`);
  return value as number;
};

export function canonicalJson(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) fail('non-canonical number'); return item; }
    if (Array.isArray(item)) return item.map(walk);
    if (!plain(item)) {
      throw new ConversionManifestError('invalid_params', 'non-plain value');
    }
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, walk(item[key])]));
  };
  return JSON.stringify(walk(value));
}
const HASH_FIELDS = ['adapterKind', 'sourceVisualKind', 'converter', 'converterVersion', 'model', 'modelVersion', 'settings', 'unitKind', 'totalUnits', 'succeededUnits', 'failedUnits', 'durationMs', 'failedRanges', 'candidates', 'confidence', 'ocr', 'imageDimensions', 'unreadableRegions', 'warnings', 'mappings', 'sourceSha256', 'sourceMimeType'] as const;
const normalizeHashMapping = (mapping: unknown): unknown => {
  if (!plain(mapping as Record<string, unknown>)) fail('invalid mapping');
  const value = mapping as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of ['sourceRange', 'derivedPageId', 'derivedSourceId', 'derivedPageSlug', 'sectionRef', 'chunkStart', 'chunkEnd']) {
    if (value[key] !== undefined) normalized[key] = value[key];
  }
  return normalized;
};
export function computeRequestHash(input: Record<string, unknown>): string {
  const normalizedInput: Record<string, unknown> = { ...input };
  if (plain(input.coverage)) {
    const coverage = input.coverage as Record<string, unknown>;
    normalizedInput.unitKind ??= coverage.unitKind;
    normalizedInput.totalUnits ??= coverage.total;
    normalizedInput.succeededUnits ??= coverage.succeeded;
    normalizedInput.failedUnits ??= coverage.failed;
    normalizedInput.failedRanges ??= coverage.failedRanges;
  }
  for (const field of IDENTITY_FIELDS) {
    if (normalizedInput[field] !== undefined) normalizedInput[field] = sanitizeIdentity(normalizedInput[field], field);
  }
  const payload: Record<string, unknown> = {};
  for (const key of HASH_FIELDS) if (normalizedInput[key] !== undefined) {
    payload[key] = key === 'mappings' && Array.isArray(normalizedInput[key])
      ? normalizedInput[key].map(normalizeHashMapping)
      : normalizedInput[key];
  }
  if (typeof payload.sourceSha256 === 'string') payload.sourceSha256 = normalizeSourceSha256(payload.sourceSha256);
  if (typeof payload.sourceMimeType === 'string') payload.sourceMimeType = normalizeMimeType(payload.sourceMimeType);
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
export function normalizeSourceSha256(value: string): string { const result = value.trim().replace(/^sha256:/i, '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(result)) fail('invalid source SHA-256', 'invalid_source_hash'); return result; }
export function normalizeMimeType(value: string): string { const result = value.trim().toLowerCase().split(';', 1)[0].trim(); if (result.length > 255 || !/^[a-z0-9!#$&^_+.-]+\/[a-z0-9!#$&^_+.-]+$/.test(result)) fail('invalid source MIME', 'invalid_source_mime'); return result; }

export function validateFailedRanges(unitKind: string, total: number, ranges: ConversionRange[]): ConversionRange[] {
  if (!units.has(unitKind as UnitKind) || !Array.isArray(ranges) || ranges.length > 1000) fail('invalid failed ranges');
  const bound = safeInt(total, 'total');
  if (unitKind === 'document') {
    if (ranges.length > 1 || (ranges[0] && (ranges[0].kind !== 'document' || Object.keys(ranges[0]).length !== 1))) fail('invalid document range');
    return ranges;
  }
  let previous = 0; let sum = 0n;
  for (const range of ranges) {
    if (!plain(range) || range.kind !== 'ordinal' || range.unitKind !== unitKind) fail('invalid range kind');
    keysExactly(range, ['kind', 'unitKind', 'start', 'end'], 'range');
    const ordinal = range as OrdinalRange;
    const start = safeInt(ordinal.start, 'range start'); const end = safeInt(ordinal.end, 'range end');
    if (start >= end || end > bound || start < previous) fail('invalid or overlapping ranges');
    previous = end; sum += BigInt(end) - BigInt(start);
    if (sum > BigInt(Number.MAX_SAFE_INTEGER)) fail('coverage span overflow');
  }
  return ranges;
}
export function validateCoverage(input: { unitKind: string; total: number; succeeded: number; failed: number; failedRanges: ConversionRange[] }) {
  if (!units.has(input.unitKind as UnitKind)) fail('invalid unit kind');
  const total = safeInt(input.total, 'total'); const succeeded = safeInt(input.succeeded, 'succeeded'); const failed = safeInt(input.failed, 'failed');
  validateFailedRanges(input.unitKind, total, input.failedRanges);
  if (input.unitKind === 'document' && (total !== 1 || failed > 1 || succeeded !== 1 - failed)) fail('invalid document coverage');
  if (input.unitKind !== 'document') {
    let sum = 0n;
    for (const range of input.failedRanges) {
      const ordinal = range as OrdinalRange;
      sum += BigInt(ordinal.end) - BigInt(ordinal.start);
    }
    if (sum !== BigInt(failed)) fail('failed units do not equal range span');
  } else if ((failed === 0) !== (input.failedRanges.length === 0)) fail('document failed-range equivalence');
  if (total !== succeeded + failed) fail('coverage counts do not balance');
  return input;
}
export function validateTimeRange(range: TimeRange, durationMs: number | null): TimeRange {
  if (!plain(range) || range.kind !== 'time_ms') fail('invalid time range');
  keysExactly(range, ['kind', 'start', 'end'], 'time range');
  const duration = durationMs === null ? fail('duration is required') : safeInt(durationMs, 'duration');
  const start = safeInt(range.start, 'time start'); const end = safeInt(range.end, 'time end');
  if (duration <= 0 || start >= end || end > duration) fail('invalid time range');
  return range;
}
export type MappingInput = { mappingOrdinal?: number; sourceRange: ConversionRange; unitKind?: UnitKind; durationMs?: number | null; derivedPageId?: number; derivedSourceId?: string; derivedPageSlug?: string; sectionRef?: string | null; chunkStart?: number | null; chunkEnd?: number | null; chunkCount?: number | null };
export type MappingContext = { unitKind: UnitKind; total: number; durationMs: number | null };
export function validateMapping(mapping: MappingInput, context?: MappingContext): MappingInput {
  const resolvedUnitKind = context?.unitKind ?? mapping.unitKind;
  if (!resolvedUnitKind || !units.has(resolvedUnitKind)) throw new ConversionManifestError('invalid_params', 'invalid mapping unit kind');
  const unitKind: UnitKind = resolvedUnitKind;
  if (context && mapping.unitKind !== undefined && mapping.unitKind !== context.unitKind) fail('mapping unit mismatch');
  if (!plain(mapping.sourceRange) || !['document', 'ordinal', 'time_ms'].includes(mapping.sourceRange.kind)) fail('invalid mapping range');
  if (mapping.sourceRange.kind === 'document') {
    if (unitKind !== 'document') fail('mapping unit mismatch');
    keysExactly(mapping.sourceRange, ['kind'], 'document range');
  }
  if (mapping.sourceRange.kind === 'ordinal') {
    if (mapping.sourceRange.unitKind !== unitKind) fail('mapping unit mismatch');
    keysExactly(mapping.sourceRange, ['kind', 'unitKind', 'start', 'end'], 'range');
    const ordinal = mapping.sourceRange as OrdinalRange;
    const start = safeInt(ordinal.start, 'range start'); const end = safeInt(ordinal.end, 'range end');
    if (start >= end) fail('invalid ordinal range');
    if (context) validateFailedRanges(unitKind, context.total, [ordinal]);
  }
  if (mapping.sourceRange.kind === 'time_ms') {
    if (!['frame', 'segment'].includes(unitKind)) fail('time mapping requires frame or segment');
    validateTimeRange(mapping.sourceRange, context?.durationMs ?? mapping.durationMs ?? null);
  }
  if ((mapping.chunkStart == null) !== (mapping.chunkEnd == null)) fail('invalid chunk bounds');
  if (mapping.chunkStart != null && mapping.chunkEnd != null) { const start = safeInt(mapping.chunkStart, 'chunk start'); const end = safeInt(mapping.chunkEnd, 'chunk end'); if (start >= end || (mapping.chunkCount != null && end > safeInt(mapping.chunkCount, 'chunk count'))) fail('invalid chunk bounds'); }
  return mapping;
}
export function validateProducerCoupling(producer: { producerKind?: string; producerId?: string | null }) { if (!['local_cli', 'stdio_mcp', 'oauth_client', 'internal_adapter'].includes(producer.producerKind ?? '')) fail('invalid producer kind'); if (producer.producerKind === 'oauth_client') { if (!producer.producerId || !/^[A-Za-z0-9._:-]{1,255}$/.test(producer.producerId)) fail('oauth producer id required'); } else if (producer.producerId !== null && producer.producerId !== undefined) fail('producer id forbidden'); return producer; }
export function validateVisualObservation(observation: { sourceVisualKind: string; risk: string; reasonCodes: string[] }): { sourceVisualKind: VisualKind; risk: Risk; reasonCodes: PlatformReason[] } {
  if (!visuals.has(observation.sourceVisualKind as VisualKind) || !['pass', 'warning', 'visual_review_required', 'hard_failure'].includes(observation.risk)) fail('invalid visual observation');
  const out = [...new Set(observation.reasonCodes)].map((reason) => { if (!reasons.has(reason as PlatformReason)) fail('invalid reason code'); return reason as PlatformReason; });
  const rank: Record<Risk, number> = { pass: 0, warning: 1, visual_review_required: 2, hard_failure: 3 };
  let risk = observation.risk as Risk;
  if (observation.sourceVisualKind === 'unknown') { out.push('OBSERVATION_INCOMPLETE'); risk = rank[risk] < 1 ? 'warning' : risk; }
  return { sourceVisualKind: observation.sourceVisualKind as VisualKind, risk, reasonCodes: [...new Set(out)].sort() };
}
export function validateObservations(input: { sourceVisualKind: string; candidates: JsonRecord; confidence: JsonRecord | null; ocr: JsonRecord; imageDimensions: JsonRecord | null }): { candidates: JsonRecord; confidence: JsonRecord | null; ocr: JsonRecord; imageDimensions: JsonRecord | null; reasons: PlatformReason[] } {
  if (!plain(input.candidates) || !plain(input.ocr) || (input.confidence !== null && !plain(input.confidence)) || (input.imageDimensions !== null && !plain(input.imageDimensions))) fail('invalid observations');
  keysExactly(input.candidates, ['images', 'tables', 'equations', 'charts'], 'candidate');
  for (const value of Object.values(input.candidates)) if (value !== null) safeInt(value, 'candidate count');
  if (input.confidence) { keysExactly(input.confidence, ['overall', 'threshold'], 'confidence'); for (const [key, value] of Object.entries(input.confidence)) nullableProbability(value, key); }
  keysExactly(input.ocr, ['state', 'confidence', 'textExtracted'], 'OCR');
  const ocrState = input.ocr.state;
  if (ocrState !== undefined && !['disabled', 'unavailable', 'empty', 'failed', 'success'].includes(String(ocrState))) fail('invalid OCR state');
  if (input.ocr.confidence !== undefined) nullableProbability(input.ocr.confidence, 'OCR confidence');
  if (input.ocr.textExtracted !== undefined && typeof input.ocr.textExtracted !== 'boolean') fail('invalid OCR textExtracted');
  if (ocrState !== undefined && input.ocr.textExtracted !== undefined && input.ocr.textExtracted !== (ocrState === 'success')) fail('OCR state/textExtracted mismatch');
  if (input.imageDimensions) { keysExactly(input.imageDimensions, ['width', 'height'], 'image dimension'); for (const value of Object.values(input.imageDimensions)) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail('invalid image dimension'); } }
  const out: PlatformReason[] = [];
  const visual = ['image', 'scan', 'mixed'].includes(input.sourceVisualKind);
  const candidatesIncomplete = visual && ['images', 'tables', 'equations', 'charts'].some((key) => !(key in input.candidates) || input.candidates[key] === null);
  const ocrIncomplete = visual && (!('state' in input.ocr) || !('confidence' in input.ocr) || !('textExtracted' in input.ocr));
  if (visual && (candidatesIncomplete || ocrIncomplete || input.imageDimensions === null)) out.push('OBSERVATION_INCOMPLETE');
  return { ...input, reasons: out };
}
export type NormalizedEvidence = {
  sourceVisualKind: string;
  coverage: { failed: number };
  unreadableRegions: ConversionRange[];
  warnings: string[];
  candidates: JsonRecord;
  confidence: JsonRecord | null;
  ocr: JsonRecord;
  imageDimensions: JsonRecord | null;
};
export function deriveNormalizedVerdict(input: NormalizedEvidence): { risk: Risk; reasonCodes: PlatformReason[] } {
  const out: PlatformReason[] = [];
  if (input.coverage.failed > 0) out.push('COVERAGE_LOSS');
  if (input.unreadableRegions.length) out.push('UNREADABLE_REGION');
  if (input.warnings.length) out.push('CONVERTER_WARNING');
  const visual = ['image', 'scan', 'mixed'].includes(input.sourceVisualKind);
  if (visual && Object.values(input.candidates).some((value) => typeof value === 'number' && value > 0)) out.push('VISUAL_CANDIDATE');
  if (input.confidence?.overall !== undefined && input.confidence?.threshold !== undefined && input.confidence.overall !== null && input.confidence.threshold !== null && input.confidence.overall < input.confidence.threshold) out.push('CONFIDENCE_BELOW_POLICY');
  if (visual && (input.imageDimensions === null || ['images', 'tables', 'equations', 'charts'].some((key) => !(key in input.candidates) || input.candidates[key] === null) || !('state' in input.ocr) || !('confidence' in input.ocr) || !('textExtracted' in input.ocr))) out.push('OBSERVATION_INCOMPLETE');
  if (input.sourceVisualKind === 'unknown') out.push('OBSERVATION_INCOMPLETE');
  const reasonCodes = [...new Set(out)].sort();
  const visualReview = reasonCodes.includes('VISUAL_CANDIDATE') || reasonCodes.includes('CONFIDENCE_BELOW_POLICY');
  const warning = reasonCodes.some((reason) => ['COVERAGE_LOSS', 'UNREADABLE_REGION', 'CONVERTER_WARNING', 'OBSERVATION_INCOMPLETE'].includes(reason));
  return { risk: visualReview ? 'visual_review_required' : warning ? 'warning' : 'pass', reasonCodes };
}

type JsonRecord = Record<string, unknown>;
const isJsonRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const SETTINGS_KEYS: Record<string, readonly string[]> = { 'image-import': ['format', 'maxDimension', 'quality'] };
const sanitizeEvidenceText = (value: string): string => value
  .replace(/\b(?:https?|ftp|file):\/\/[^\s"'<>]+/gi, '<redacted:url>')
  .replace(/((?:^|[\s=(]))(?:"(?:\/|[A-Za-z]:[\\/])[^"<>]+"|'(?:\/|[A-Za-z]:[\\/])[^'<>]+')/g, '$1<redacted:path>')
  .replace(/((?:^|[\s=(]))(?:\/|[A-Za-z]:[\\/])[^"'<> \s]*/g, '$1<redacted:path>')
  .replace(/\bauthorization(?:\s*[:=]\s*|\s+)(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '<redacted:credential>')
  .replace(/\bcookie\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, '<redacted:credential>')
  .replace(/\b(?:password|passwd|token|secret|api[_-]?key|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '<redacted:credential>');
function boundedValue(value: unknown, depth: number, sanitizeText = false, allowedKeys?: readonly string[]): unknown {
  if (depth > 8) fail('manifest exceeds nesting depth');
  if (Array.isArray(value)) {
    if (value.length > 128) fail('manifest array exceeds bound');
    return value.map((entry) => boundedValue(entry, depth + 1, sanitizeText, allowedKeys));
  }
  if (value !== null && typeof value === 'object' && plain(value)) {
    const result: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      if (allowedKeys && depth === 0 && !allowedKeys.includes(key)) fail('unknown setting key');
      result[key] = boundedValue(entry, depth + 1, sanitizeText, allowedKeys);
    }
    return result;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return sanitizeText ? sanitizeEvidenceText(value) : value;
  fail('unsupported manifest value');
}
export function sanitizeManifest(input: JsonRecord, adapterKind?: string): JsonRecord {
  if (!plain(input.settings)) fail('invalid settings');
  const allowed = adapterKind === 'image-import' ? SETTINGS_KEYS['image-import'] : [];
  const sanitized = boundedValue({ ...input, settings: boundedValue(input.settings, 0, true, allowed) }, 0, true);
  if (!isJsonRecord(sanitized)) throw new ConversionManifestError('invalid_params', 'invalid manifest');
  const rawWarnings: unknown = sanitized.warnings;
  if (!Array.isArray(rawWarnings) || rawWarnings.some((value: unknown) => typeof value !== 'string') || rawWarnings.length > 32) fail('invalid warnings');
  const warningBytes = (rawWarnings as string[]).reduce((total: number, value: string) => total + new TextEncoder().encode(value).byteLength, 0);
  if (warningBytes > 8192) fail('warnings exceed size cap');
  if (new TextEncoder().encode(canonicalJson(sanitized)).byteLength > 8192) fail('manifest exceeds size cap');
  return sanitized;
}
function normalizeFile(row: FileRow): FileRow { return { ...row, id: Number(row.id), page_id: row.page_id == null ? null : Number(row.page_id), size_bytes: row.size_bytes == null ? null : Number(row.size_bytes), created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at) }; }
export async function getFileById(engine: BrainEngine, sourceId: string, fileId: number): Promise<FileRow | null> { const rows = await engine.executeRaw<FileRow>('SELECT id,source_id,page_slug,page_id,filename,storage_path,mime_type,size_bytes,content_hash,metadata,created_at FROM files WHERE source_id=$1 AND id=$2', [sourceId, fileId]); return rows[0] ? normalizeFile(rows[0]) : null; }
export async function getFileByIdForUpdate(engine: BrainEngine, sourceId: string, fileId: number): Promise<FileRow | null> { const rows = await engine.executeRaw<FileRow>('SELECT id,source_id,page_slug,page_id,filename,storage_path,mime_type,size_bytes,content_hash,metadata,created_at FROM files WHERE source_id=$1 AND id=$2 FOR UPDATE', [sourceId, fileId]); return rows[0] ? normalizeFile(rows[0]) : null; }

export type ConversionOperationContext =
  | { transport: 'local_cli'; remote: false; sourceId?: string }
  | { transport: 'stdio_mcp'; remote: true; sourceId: string }
  | { transport: 'oauth_http'; remote: true; sourceId: string; auth: { clientId: string } }
  | { transport: 'internal_adapter' };
export interface ConversionManifestInput { sourceId: string; fileId: number; idempotencyKey: string; adapterKind: string; sourceVisualKind: string; converter: string; converterVersion: string; model?: string | null; modelVersion?: string | null; settings: JsonRecord; unitKind: string; coverage: { total: number; succeeded: number; failed: number; failedRanges: ConversionRange[] }; candidates: JsonRecord; confidence: JsonRecord | null; ocr: JsonRecord; imageDimensions: JsonRecord | null; unreadableRegions: ConversionRange[]; warnings: string[]; mappings: MappingInput[]; startedAt?: string | Date; completedAt?: string | Date; durationMs?: number | null; risk?: string; reasonCodes?: PlatformReason[]; }
export type ManifestRow = JsonRecord & { receiptId: string; sourceId: string; fileId: number; manifestVersion: number; totalUnits: number; succeededUnits: number; failedUnits: number; durationMs: number | null; startedAt: string; completedAt: string };
function rowManifest(row: JsonRecord): ManifestRow {
  const result: JsonRecord = {
    receiptId: row.receipt_id,
    sourceId: row.source_id,
    fileId: Number(row.file_id),
    sourceSha256: row.source_sha256,
    sourceMimeType: row.source_mime_type,
    manifestVersion: Number(row.manifest_version),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    producerKind: row.producer_kind,
    producerId: row.producer_id,
    adapterKind: row.adapter_kind,
    sourceVisualKind: row.source_visual_kind,
    converter: row.converter,
    converterVersion: row.converter_version,
    model: row.model,
    modelVersion: row.model_version,
    settings: row.settings,
    startedAt: new Date(String(row.started_at)).toISOString(),
    completedAt: new Date(String(row.completed_at)).toISOString(),
    unitKind: row.unit_kind,
    totalUnits: Number(row.total_units),
    succeededUnits: Number(row.succeeded_units),
    failedUnits: Number(row.failed_units),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    failedRanges: row.failed_ranges,
    candidates: row.candidates,
    confidence: row.confidence,
    ocr: row.ocr,
    imageDimensions: row.image_dimensions,
    unreadableRegions: row.unreadable_regions,
    warnings: row.adapter_warnings,
    risk: row.risk,
    reasonCodes: row.reason_codes,
  };
  return result as ManifestRow;
}
function producerFor(input: ConversionManifestInput, context: ConversionOperationContext): { kind: string; id: string | null } {
  if (!context || typeof context !== 'object') fail('missing operation context', 'permission_denied');
  switch (context.transport) {
    case 'local_cli':
      if (context.remote !== false || (context.sourceId !== undefined && context.sourceId !== input.sourceId)) fail('permission denied', 'permission_denied');
      return { kind: 'local_cli', id: null };
    case 'stdio_mcp':
      if (context.remote !== true || !context.sourceId || context.sourceId !== input.sourceId) fail('permission denied', 'permission_denied');
      return { kind: 'stdio_mcp', id: null };
    case 'oauth_http':
      if (context.remote !== true || context.sourceId !== input.sourceId || !/^[A-Za-z0-9._:-]{1,255}$/.test(context.auth.clientId)) fail('permission denied', 'permission_denied');
      return { kind: 'oauth_client', id: context.auth.clientId };
    case 'internal_adapter':
      if (input.adapterKind !== 'image-import') fail('permission denied', 'permission_denied');
      return { kind: 'internal_adapter', id: null };
    default:
      return fail('permission denied', 'permission_denied');
}
}
export async function createConversionManifest(
  engine: BrainEngine,
  input: ConversionManifestInput,
  context: ConversionOperationContext,
): Promise<{ created: boolean; receipt: ManifestRow }> {
  return engine.transaction(async (tx) => {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) {
      fail('invalid idempotency key');
    }
    if (input.risk !== undefined || input.reasonCodes !== undefined) fail('caller verdict fields are not accepted');
    const identity = sanitizeIdentities(input as unknown as Record<string, unknown>);
    const producer = producerFor(input, context);
    validateProducerCoupling({ producerKind: producer.kind, producerId: producer.id });

    const lockedFile = await getFileByIdForUpdate(tx, input.sourceId, input.fileId);
    if (!lockedFile) {
      throw new ConversionManifestError('invalid_source_file', 'source file missing');
    }
    const sourceSha256 = normalizeSourceSha256(lockedFile.content_hash ?? '');
    const sourceMimeType = normalizeMimeType(lockedFile.mime_type ?? '');

    validateCoverage({ ...input.coverage, unitKind: input.unitKind });
    const observations = validateObservations({
      sourceVisualKind: input.sourceVisualKind,
      candidates: input.candidates,
      confidence: input.confidence,
      ocr: input.ocr,
      imageDimensions: input.imageDimensions,
    });
    for (const range of input.unreadableRegions) {
      if (!plain(range) || range.kind === 'document' && input.unitKind !== 'document') fail('unreadable range unit mismatch');
      if (range.kind === 'document') validateFailedRanges('document', input.coverage.total, [range]);
      if (range.kind === 'time_ms') {
        if (!['frame', 'segment'].includes(input.unitKind)) fail('unreadable time range unit mismatch');
        validateTimeRange(range, input.durationMs ?? null);
      } else if (range.kind === 'ordinal') {
        if (range.unitKind !== input.unitKind) fail('unreadable range unit mismatch');
        validateFailedRanges(input.unitKind as UnitKind, input.coverage.total, [range]);
      } else if (range.kind !== 'document') fail('invalid unreadable range kind');
    }
    for (const mapping of input.mappings) validateMapping(mapping, { unitKind: input.unitKind as UnitKind, total: input.coverage.total, durationMs: input.durationMs ?? null });
    const safeInput = sanitizeManifest({
      settings: input.settings,
      candidates: observations.candidates,
      confidence: observations.confidence,
      ocr: observations.ocr,
      imageDimensions: observations.imageDimensions,
      unreadableRegions: input.unreadableRegions,
      warnings: input.warnings,
      mappings: input.mappings,
    }, identity.adapterKind as string);
    const verdict = deriveNormalizedVerdict({
      sourceVisualKind: input.sourceVisualKind,
      coverage: input.coverage,
      unreadableRegions: input.unreadableRegions,
      warnings: input.warnings,
      candidates: observations.candidates,
      confidence: observations.confidence,
      ocr: observations.ocr,
      imageDimensions: observations.imageDimensions,
    });
    const visual = validateVisualObservation({
      sourceVisualKind: input.sourceVisualKind,
      risk: verdict.risk,
      reasonCodes: verdict.reasonCodes,
    });
    if (!Array.isArray(safeInput.mappings)) fail('invalid mappings');
    const safeMappings = safeInput.mappings as unknown[];

    const requestHash = computeRequestHash({
      adapterKind: identity.adapterKind,
      sourceVisualKind: input.sourceVisualKind,
      converter: identity.converter,
      converterVersion: identity.converterVersion,
      model: identity.model,
      modelVersion: identity.modelVersion,
      settings: safeInput.settings,
      unitKind: input.unitKind,
      totalUnits: input.coverage.total,
      succeededUnits: input.coverage.succeeded,
      failedUnits: input.coverage.failed,
      durationMs: input.durationMs ?? null,
      failedRanges: input.coverage.failedRanges,
      candidates: safeInput.candidates,
      confidence: safeInput.confidence,
      ocr: safeInput.ocr,
      imageDimensions: safeInput.imageDimensions,
      unreadableRegions: safeInput.unreadableRegions,
      warnings: safeInput.warnings,
      mappings: safeMappings.map((mapping: unknown) => {
        const value = mapping as JsonRecord;
        return {
          sourceRange: value.sourceRange,
          derivedPageId: value.derivedPageId,
          derivedSourceId: input.sourceId,
          derivedPageSlug: value.derivedPageSlug,
          sectionRef: value.sectionRef,
          chunkStart: value.chunkStart,
          chunkEnd: value.chunkEnd,
        };
      }),
      sourceSha256,
      sourceMimeType,
    });

    const existing = await tx.executeRaw<JsonRecord>(
      'SELECT * FROM conversion_manifests WHERE source_id=$1 AND file_id=$2 AND idempotency_key=$3',
      [input.sourceId, input.fileId, input.idempotencyKey],
    );
    if (existing[0]) {
      if (existing[0].request_hash !== requestHash) {
        fail('idempotency conflict', 'idempotency_conflict');
      }
      return { created: false, receipt: rowManifest(existing[0]) };
    }

    for (const mapping of input.mappings) {
      if (
        mapping.derivedPageId == null ||
        mapping.derivedSourceId !== input.sourceId ||
        mapping.derivedPageSlug == null
      ) {
        fail('mapping target is invalid');
      }
      const page = await tx.executeRaw<JsonRecord>(
        'SELECT id FROM pages WHERE id=$1 AND source_id=$2 AND slug=$3',
        [mapping.derivedPageId, input.sourceId, mapping.derivedPageSlug],
      );
      if (!page[0]) fail('mapping target is missing');
      if (mapping.chunkStart != null && mapping.chunkEnd != null) {
        const chunkRows = await tx.executeRaw<JsonRecord>(
          'SELECT COUNT(*) AS count FROM content_chunks WHERE page_id=$1 AND chunk_index >= $2 AND chunk_index < $3',
          [mapping.derivedPageId, mapping.chunkStart, mapping.chunkEnd],
        );
        const rawCount = chunkRows[0]?.count;
        const chunkCount = typeof rawCount === 'bigint' ? Number(rawCount) : Number(rawCount ?? 0);
        if (!Number.isSafeInteger(chunkCount) || chunkCount !== mapping.chunkEnd - mapping.chunkStart) {
          fail('mapping chunk bounds invalid');
        }
      }
    }

    const started = input.startedAt ? new Date(input.startedAt) : new Date();
    const completed = input.completedAt ? new Date(input.completedAt) : started;
    if (
      Number.isNaN(started.getTime()) ||
      Number.isNaN(completed.getTime()) ||
      completed < started
    ) {
      fail('invalid timestamps');
    }
    const receiptId = randomUUID().toLowerCase();
    const values: unknown[] = [
      receiptId,
      input.sourceId,
      input.fileId,
      sourceSha256,
      sourceMimeType,
      input.idempotencyKey,
      requestHash,
      producer.kind,
      producer.id,
      identity.adapterKind,
      input.sourceVisualKind,
      identity.converter,
      identity.converterVersion,
      identity.model,
      identity.modelVersion,
      canonicalJson(safeInput.settings),
      started,
      completed,
      input.unitKind,
      input.coverage.total,
      input.coverage.succeeded,
      input.coverage.failed,
      input.durationMs ?? null,
      canonicalJson(input.coverage.failedRanges),
      canonicalJson(safeInput.candidates),
      safeInput.confidence == null ? null : canonicalJson(safeInput.confidence),
      canonicalJson(safeInput.ocr),
      safeInput.imageDimensions == null ? null : canonicalJson(safeInput.imageDimensions),
      canonicalJson(input.unreadableRegions),
      canonicalJson(safeInput.warnings),
      visual.risk,
      canonicalJson(visual.reasonCodes),
    ];
    await tx.executeRaw(
      'INSERT INTO conversion_manifests (receipt_id,source_id,file_id,source_sha256,source_mime_type,manifest_version,idempotency_key,request_hash,producer_kind,producer_id,adapter_kind,source_visual_kind,converter,converter_version,model,model_version,settings,started_at,completed_at,unit_kind,total_units,succeeded_units,failed_units,duration_ms,failed_ranges,candidates,confidence,ocr,image_dimensions,unreadable_regions,adapter_warnings,risk,reason_codes) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::text::jsonb,$17,$18,$19,$20,$21,$22,$23,$24::text::jsonb,$25::text::jsonb,$26::text::jsonb,$27::text::jsonb,$28::text::jsonb,$29::text::jsonb,$30::text::jsonb,$31,ARRAY(SELECT jsonb_array_elements_text($32::text::jsonb) ORDER BY 1))',
      values,
    );
    for (const [ordinal, mapping] of input.mappings.entries()) {
      await tx.executeRaw(
        'INSERT INTO conversion_manifest_mappings (receipt_id,mapping_ordinal,source_range,derived_page_id,derived_source_id,derived_page_slug,section_ref,chunk_start,chunk_end) VALUES ($1,$2,$3::text::jsonb,$4,$5,$6,$7,$8,$9)',
        [
          receiptId,
          ordinal,
          canonicalJson(mapping.sourceRange),
          mapping.derivedPageId,
          input.sourceId,
          mapping.derivedPageSlug,
          (safeInput.mappings as JsonRecord[])[ordinal]?.sectionRef ?? null,
          mapping.chunkStart ?? null,
          mapping.chunkEnd ?? null,
        ],
      );
    }
    const rows = await tx.executeRaw<JsonRecord>(
      'SELECT * FROM conversion_manifests WHERE receipt_id=$1',
      [receiptId],
    );
    return { created: true, receipt: rowManifest(rows[0]) };
  });
}
export async function getConversionManifest(
  engine: BrainEngine,
  receiptId: string,
): Promise<ManifestRow | null> {
  const rows = await engine.executeRaw<JsonRecord>(
    'SELECT * FROM conversion_manifests WHERE receipt_id=$1',
    [receiptId],
  );
  return rows[0] ? rowManifest(rows[0]) : null;
}
export async function listConversionManifests(
  engine: BrainEngine,
  sourceId: string,
  opts: { fileId?: number } = {},
): Promise<ManifestRow[]> {
  const rows = await engine.executeRaw<JsonRecord>(
    'SELECT * FROM conversion_manifests WHERE source_id=$1 AND ($2::bigint IS NULL OR file_id=$2) ORDER BY completed_at DESC, receipt_id DESC',
    [sourceId, opts.fileId ?? null],
  );
  return rows.map(rowManifest);
}
export async function listConversionMappings(
  engine: BrainEngine,
  receiptId: string,
): Promise<JsonRecord[]> {
  const rows = await engine.executeRaw<JsonRecord>(
    'SELECT receipt_id,mapping_ordinal,source_range,derived_page_id,derived_source_id,derived_page_slug,section_ref,chunk_start,chunk_end FROM conversion_manifest_mappings WHERE receipt_id=$1 ORDER BY mapping_ordinal',
    [receiptId],
  );
  return rows.map((row) => ({
    receiptId: row.receipt_id,
    mappingOrdinal: Number(row.mapping_ordinal),
    sourceRange: row.source_range,
    derivedPageId: Number(row.derived_page_id),
    derivedSourceId: row.derived_source_id,
    derivedPageSlug: row.derived_page_slug,
    sectionRef: row.section_ref,
    chunkStart: row.chunk_start == null ? null : Number(row.chunk_start),
    chunkEnd: row.chunk_end == null ? null : Number(row.chunk_end),
  }));
}
export async function inspectConversionFile(
  engine: BrainEngine,
  opts: { sourceId: string; fileId: number },
): Promise<{ state: 'legacy_absent' | 'receipt_found' | 'unsupported_manifest_version' | 'file_missing' }> {
  if (!(await getFileById(engine, opts.sourceId, opts.fileId))) {
    return { state: 'file_missing' };
  }
  const rows = await engine.executeRaw<JsonRecord>(
    'SELECT manifest_version FROM conversion_manifests WHERE source_id=$1 AND file_id=$2 ORDER BY completed_at DESC LIMIT 1',
    [opts.sourceId, opts.fileId],
  );
  if (!rows[0]) return { state: 'legacy_absent' };
  return {
    state: Number(rows[0].manifest_version) === 1
      ? 'receipt_found'
      : 'unsupported_manifest_version',
  };
}
export async function verifyConversionManifestLinkage(
  engine: BrainEngine,
  opts: {
    sourceId: string;
    fileId: number;
    physical?: boolean;
    transport?: string;
    byteReader?: () => Promise<Uint8Array>;
    bytes?: Uint8Array;
  },
): Promise<JsonRecord> {
  const file = await getFileById(engine, opts.sourceId, opts.fileId);
  const empty: ByteCheck = {
    reason: opts.transport === 'oauth_http' ? 'remote_caller' : 'not_requested',
    reasons: [],
  };
  if (!file) {
    return {
      status: 'file_missing',
      matchesHash: null,
      matchesMime: null,
      reasons: ['DB_SOURCE_FILE_MISSING'],
      byteCheck: empty,
    };
  }
  const manifest = (
    await listConversionManifests(engine, opts.sourceId, { fileId: opts.fileId })
  )[0];
  if (!manifest) {
    return {
      status: 'legacy_absent',
      matchesHash: null,
      matchesMime: null,
      reasons: [],
      byteCheck: empty,
    };
  }
  if (manifest.manifestVersion !== 1) {
    return { status: 'unsupported', matchesHash: null, matchesMime: null, reasons: ['UNSUPPORTED_MANIFEST_VERSION'], byteCheck: empty };
  }
  let hashMatches = false;
  let mimeMatches = false;
  let malformedSnapshot = false;
  try { hashMatches = manifest.sourceSha256 === normalizeSourceSha256(file.content_hash ?? ''); } catch { malformedSnapshot = true; }
  try { mimeMatches = manifest.sourceMimeType === normalizeMimeType(file.mime_type ?? ''); } catch { malformedSnapshot = true; }
  const out: PlatformReason[] = [];
  if (!hashMatches) out.push('DB_SOURCE_HASH_MISMATCH');
  if (!mimeMatches) out.push('DB_SOURCE_MIME_MISMATCH');

  let byteCheck = empty;
  if (opts.physical && opts.transport !== 'oauth_http') {
    try {
      const bytes = opts.bytes ?? (opts.byteReader ? await opts.byteReader() : null);
      if (!bytes) {
        byteCheck = { reason: 'unavailable', reasons: [] };
        out.push('PHYSICAL_SOURCE_UNAVAILABLE');
      } else if (
        createHash('sha256').update(bytes).digest('hex') !== manifest.sourceSha256
      ) {
        byteCheck = { reason: 'checked_mismatch', reasons: [] };
        out.push('PHYSICAL_SOURCE_HASH_MISMATCH');
      } else {
        byteCheck = { reason: 'checked_match', reasons: [] };
      }
    } catch {
      byteCheck = { reason: 'read_error', reasons: [] };
      out.push('PHYSICAL_SOURCE_UNAVAILABLE');
    }
  }
  return {
    status: malformedSnapshot ? 'corrupt' : (out.includes('DB_SOURCE_HASH_MISMATCH') || out.includes('DB_SOURCE_MIME_MISMATCH') || out.includes('PHYSICAL_SOURCE_HASH_MISMATCH')) ? 'mismatch' : 'verified',
    matchesHash: hashMatches,
    matchesMime: mimeMatches,
    reasons: out,
    byteCheck,
  };
}
