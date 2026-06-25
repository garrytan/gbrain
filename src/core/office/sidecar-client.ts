// src/core/office/sidecar-client.ts
//
// Thin HTTP client for the Docling sidecar (docs/proposals/office-ingest.md §7).
// Uses global fetch + FormData (Bun / Node 18+). Fail-loud: any non-2xx or
// transport error throws, so the adapter can return a clean ImportResult error.

import { type DocIR } from './types.ts';

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface ParseOpts {
  wantPageImages?: boolean;
  /** Per-request timeout. Generous default — first parse may load models. */
  timeoutMs?: number;
}

/** POST a document to the sidecar and return its DocIR. Throws on failure. */
export async function parseViaSidecar(
  url: string,
  filename: string,
  bytes: Uint8Array,
  opts: ParseOpts = {},
): Promise<DocIR> {
  const form = new FormData();
  const name = filename.split(/[\\/]/).pop() || 'upload';
  // Cast: a Uint8Array is a valid BlobPart at runtime; TS's lib types are
  // over-strict about the underlying buffer possibly being SharedArrayBuffer.
  form.append('file', new Blob([bytes as unknown as BlobPart]), name);
  form.append('want_page_images', String(!!opts.wantPageImages));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180_000);
  let res: Response;
  try {
    res = await fetch(`${base(url)}/parse`, {
      method: 'POST',
      body: form,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`docling /parse HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as DocIR;
}

/** Probe the sidecar's health. Returns false on any error (never throws). */
export async function sidecarHealthy(url: string, timeoutMs = 5_000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base(url)}/health`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
