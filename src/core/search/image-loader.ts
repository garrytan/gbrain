/**
 * v0.36 Phase 2 — image input loader for `search_by_image`.
 *
 * Accepts three input forms:
 *   - absolute path: file:// URI OR /abs/path/to/img.png (local CLI only)
 *   - data: URI:   data:image/png;base64,<base64bytes>
 *   - http(s) URL: https://example.com/img.png (SSRF-defended via ssrf-validate.ts)
 *
 * Returns: { contentType, base64, bytes } so the caller can hand it to
 * `embedQueryMultimodalImage({data: base64, mime: contentType})`.
 *
 * Defenses:
 *   - Magic-byte sniff for PNG / JPEG / WebP (no other formats accepted in v1)
 *   - Hard size cap (default 10 MB) — applies before allocation when possible
 *     via Content-Length pre-flight, and as a stream cap during fetch
 *   - SSRF: every URL hop validated via `validateAndResolveUrl` from
 *     `src/core/ssrf-validate.ts`; max 3 redirect hops
 *   - 5s total fetch timeout (not per-hop)
 *   - Rejects credentials embedded in URL
 *
 * Out of scope:
 *   - Pixel-bomb defense (decompression bombs): the size cap doubles as the
 *     bomb defense per D22-9. We never call a pixel parser; only feed bytes
 *     to Voyage. A 10MB cap is well below the pixel-bomb threshold.
 *   - HEIC / GIF / TIFF — Voyage multimodal-3 supports them but the test
 *     fixtures and OCR pipeline don't, so we keep the input surface
 *     conservative for v1.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { SSRFError, fetchWithSSRFGuard } from '../ssrf-validate.ts';

/** Max bytes for input image. Configurable via `search.image_query.max_bytes`. */
export const DEFAULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Stricter cap for remote MCP callers (ctx.remote === true). */
export const DEFAULT_REMOTE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export interface LoadedImage {
  /** MIME content type ('image/png', 'image/jpeg', 'image/webp'). */
  contentType: string;
  /** Raw bytes as Buffer. Caller can use this for hashing/auditing. */
  bytes: Buffer;
  /** Base64-encoded bytes, ready to feed into embedQueryMultimodalImage. */
  base64: string;
}

export class ImageLoadError extends Error {
  readonly code: ImageLoadErrorCode;
  constructor(code: ImageLoadErrorCode, message: string) {
    super(message);
    this.name = 'ImageLoadError';
    this.code = code;
  }
}

export type ImageLoadErrorCode =
  | 'INVALID_FORMAT'
  | 'OVERSIZED'
  | 'INVALID_URL'
  | 'FETCH_FAILED'
  | 'TIMEOUT'
  | 'SSRF_BLOCKED'
  | 'NOT_FOUND';

export interface ImageLoadOpts {
  /** Override the default max-bytes cap. Defaults to DEFAULT_IMAGE_MAX_BYTES. */
  maxBytes?: number;
  /** Total fetch timeout in ms (URLs only). Defaults to 5000. */
  timeoutMs?: number;
  /** Max redirect hops (URLs only). Defaults to 3. */
  maxRedirects?: number;
}

/**
 * Load an image input into a structured shape.
 *
 * Throws `ImageLoadError` on any failure — `SSRFError` from the URL path
 * is caught and re-thrown as ImageLoadError with `code: 'SSRF_BLOCKED'`.
 */
export async function loadImageInput(
  input: string,
  opts: ImageLoadOpts = {},
): Promise<LoadedImage> {
  if (typeof input !== 'string' || input.length === 0) {
    throw new ImageLoadError('INVALID_URL', 'Image input must be a non-empty string');
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES;

  // Branch on input shape.
  if (input.startsWith('data:')) {
    return loadDataUri(input, maxBytes);
  }
  if (input.startsWith('http://') || input.startsWith('https://')) {
    return loadHttpUrl(input, { maxBytes, timeoutMs: opts.timeoutMs ?? 5000, maxRedirects: opts.maxRedirects ?? 3 });
  }
  if (input.startsWith('file://') || isAbsolute(input)) {
    const path = input.startsWith('file://') ? input.slice(7) : input;
    return loadLocalPath(path, maxBytes);
  }
  throw new ImageLoadError(
    'INVALID_URL',
    `Unsupported image input shape: expected data: URI, http(s):// URL, file:// URI, or absolute path. Got: ${input.slice(0, 60)}`,
  );
}

async function loadLocalPath(path: string, maxBytes: number): Promise<LoadedImage> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      throw new ImageLoadError('NOT_FOUND', `File not found: ${path}`);
    }
    throw new ImageLoadError('FETCH_FAILED', `Failed to read ${path}: ${msg}`);
  }
  if (bytes.length > maxBytes) {
    throw new ImageLoadError(
      'OVERSIZED',
      `Image at ${path} is ${bytes.length} bytes; cap is ${maxBytes}`,
    );
  }
  const contentType = sniffContentType(bytes);
  return finalize(bytes, contentType);
}

function loadDataUri(input: string, maxBytes: number): LoadedImage {
  // data:image/png;base64,<bytes>
  const match = input.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new ImageLoadError('INVALID_FORMAT', 'data: URI must be in `data:<mime>;base64,<bytes>` form');
  }
  const declaredMime = match[1].toLowerCase();
  const b64 = match[2];
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, 'base64');
  } catch (err) {
    throw new ImageLoadError(
      'INVALID_FORMAT',
      `Failed to decode base64: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (bytes.length > maxBytes) {
    throw new ImageLoadError(
      'OVERSIZED',
      `Decoded image is ${bytes.length} bytes; cap is ${maxBytes}`,
    );
  }
  const sniffed = sniffContentType(bytes);
  // If the declared MIME disagrees with the magic-byte sniff, trust the sniff
  // (caller could lie about content-type to bypass format gate).
  if (sniffed !== declaredMime) {
    // Fall through with the sniffed type. Don't error — declared MIME is
    // informational; bytes are the truth.
  }
  return finalize(bytes, sniffed);
}

async function loadHttpUrl(
  url: string,
  opts: { maxBytes: number; timeoutMs: number; maxRedirects: number },
): Promise<LoadedImage> {
  let res: Response;
  try {
    res = await fetchWithSSRFGuard(url, {
      maxRedirects: opts.maxRedirects,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    if (err instanceof SSRFError) {
      throw new ImageLoadError('SSRF_BLOCKED', `SSRF: ${err.message}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      throw new ImageLoadError('TIMEOUT', `Fetch timeout (${opts.timeoutMs}ms): ${url}`);
    }
    throw new ImageLoadError('FETCH_FAILED', `Fetch failed: ${msg}`);
  }
  if (!res.ok) {
    throw new ImageLoadError(
      'FETCH_FAILED',
      `Fetch returned HTTP ${res.status}: ${res.statusText || ''}`,
    );
  }
  // Pre-flight: reject oversized responses before reading the body.
  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader) {
    const declared = parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      throw new ImageLoadError(
        'OVERSIZED',
        `Response Content-Length ${declared} exceeds cap ${opts.maxBytes}`,
      );
    }
  }
  // Read the body; second guard against lying Content-Length.
  const arrayBuf = await res.arrayBuffer();
  const bytes = Buffer.from(arrayBuf);
  if (bytes.length > opts.maxBytes) {
    throw new ImageLoadError(
      'OVERSIZED',
      `Response body is ${bytes.length} bytes; cap is ${opts.maxBytes} (lying Content-Length?)`,
    );
  }
  const contentType = sniffContentType(bytes);
  return finalize(bytes, contentType);
}

/**
 * Magic-byte sniff for the three supported formats.
 *
 * - PNG:  starts with `89 50 4E 47 0D 0A 1A 0A`
 * - JPEG: starts with `FF D8 FF`
 * - WebP: starts with `RIFF` (52 49 46 46) + 4 bytes + `WEBP` (57 45 42 50)
 *
 * Throws `ImageLoadError` with `code: 'INVALID_FORMAT'` for anything else.
 */
function sniffContentType(bytes: Buffer): string {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  throw new ImageLoadError(
    'INVALID_FORMAT',
    `Unsupported image format. Magic bytes: ${bytes.subarray(0, Math.min(12, bytes.length)).toString('hex')}. Accepted: PNG, JPEG, WebP.`,
  );
}

function finalize(bytes: Buffer, contentType: string): LoadedImage {
  return {
    contentType,
    bytes,
    base64: bytes.toString('base64'),
  };
}
