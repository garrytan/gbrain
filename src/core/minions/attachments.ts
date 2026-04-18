/**
 * Attachment validation for Minions.
 *
 * Decoupled from queue.ts so it can be unit-tested without a DB.
 * Pure function: takes input + opts, returns ok-or-error.
 *
 * The DB UNIQUE (job_id, filename) constraint is the authoritative duplicate
 * fence; the in-memory `existingFilenames` check just gives a faster, clearer
 * error before the round-trip.
 */

import { createHash } from 'node:crypto';
import type { AttachmentInput } from './types.ts';

export interface AttachmentValidationOpts {
  maxBytes: number;
  existingFilenames?: Set<string>;
}

export interface NormalizedAttachment {
  filename: string;
  content_type: string;
  bytes: Buffer;
  size_bytes: number;
  sha256: string;
}

export type ValidationResult =
  | { ok: true; normalized: NormalizedAttachment }
  | { ok: false; error: string };

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTENT_TYPE_RE = /^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+(;\s*[A-Za-z0-9!#$&^_.+\-]+=[A-Za-z0-9!#$&^_.+\-"]+)*$/;

export function validateAttachment(input: AttachmentInput, opts: AttachmentValidationOpts): ValidationResult {
  if (!input.filename || input.filename.trim() === '') {
    return { ok: false, error: 'filename is required' };
  }
  const filename = input.filename;

  // Reject path traversal, separators, null bytes. Filenames are leaves only.
  if (
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    filename.includes('\0')
  ) {
    return { ok: false, error: `filename contains invalid characters: ${JSON.stringify(filename)}` };
  }

  if (!input.content_type || !CONTENT_TYPE_RE.test(input.content_type)) {
    return { ok: false, error: 'content_type missing or malformed' };
  }

  if (input.content_base64 == null || input.content_base64 === '') {
    return { ok: false, error: 'content_base64 is empty' };
  }

  // Strict base64: only A-Z a-z 0-9 + / and trailing =. Reject whitespace and
  // line breaks so callers normalize before sending (no silent corruption).
  if (!BASE64_RE.test(input.content_base64)) {
    return { ok: false, error: 'content_base64 contains invalid characters' };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.content_base64, 'base64');
  } catch (e) {
    return { ok: false, error: `base64 decode failed: ${(e as Error).message}` };
  }

  if (bytes.length === 0) {
    return { ok: false, error: 'attachment content is empty after base64 decode' };
  }

  if (bytes.length > opts.maxBytes) {
    return {
      ok: false,
      error: `attachment size ${bytes.length} exceeds maxBytes ${opts.maxBytes}`,
    };
  }

  if (opts.existingFilenames?.has(filename)) {
    return { ok: false, error: `filename already exists for this job: ${filename}` };
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  return {
    ok: true,
    normalized: {
      filename,
      content_type: input.content_type,
      bytes,
      size_bytes: bytes.length,
      sha256,
    },
  };
}
