import { z } from 'zod';
import { opError } from '../ops/contract.ts';
import { previewHash } from '../persistence/preview-approval.ts';

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/).refine(value => {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
}).transform(value => new Date(value).toISOString());

const entry = z.strictObject({
  id: z.number().int().positive().safe(),
  claim_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expected_valid_from: instant,
  valid_from: instant,
  evidence: z.string().trim().min(1).max(500).refine(value => !/[\r\n\u0000-\u001f\u007f]/.test(value)),
}).refine(value => value.valid_from >= '1900-01-01T00:00:00.000Z'
  && value.valid_from.slice(0, 10) < value.expected_valid_from.slice(0, 10));

export type FactDateEvidence = z.infer<typeof entry>;

export interface FactDateEvidenceFile {
  path: string;
  digest: string;
  rows: FactDateEvidence[];
}

export function invalidFactDateEvidence() {
  return opError('invalid_params',
    'Invalid --evidence-file; no date changes were prepared.',
    'Use a JSON array with unique fact IDs, each claim SHA-256, the expected UTC start, the earlier UTC start and supporting evidence.');
}

/** Validate explicit operator evidence without I/O. */
export function parseFactDateEvidence(raw: string, path: string): FactDateEvidenceFile {
  try {
    const rows = z.array(entry).min(1).parse(JSON.parse(raw)).sort((a, b) => a.id - b.id);
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw invalidFactDateEvidence();
    return { path, digest: previewHash(rows), rows };
  } catch {
    throw invalidFactDateEvidence();
  }
}
