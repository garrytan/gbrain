import { createHash } from 'node:crypto';
import type { Page } from '../types.ts';

export function hasRawTranscriptSidecar(page: Page): boolean {
  const raw = page.frontmatter?.raw_transcript;
  return typeof raw === 'string' && raw.trim().length > 0;
}

export function regularPageVersionToken(page: Page): string {
  const hash = page.content_hash ?? createHash('sha256')
    .update(JSON.stringify({ title: page.title, type: page.type, compiled_truth: page.compiled_truth,
      timeline: page.timeline || '', frontmatter: page.frontmatter || {} }))
    .digest('hex');
  const effectiveDate = page.effective_date ? new Date(page.effective_date).toISOString().slice(0, 10) : 'none';
  return `page-${hash}-${effectiveDate}`;
}

export function conversationSnapshotVersionToken(page: Page, body: string): string {
  if (!hasRawTranscriptSidecar(page)) return regularPageVersionToken(page);
  return `sidecar-${createHash('sha256').update(JSON.stringify({ body, title: page.title, type: page.type,
    frontmatter: page.frontmatter, effective_date: page.effective_date ?? null })).digest('hex')}`;
}
