import type { MemoryCandidateEntry, Page, PageType } from '../types.ts';

export interface CanonicalCandidatePagePatchOptions {
  now: string;
  timelineNote: string;
}

/**
 * Build a governed merge-patch body that appends a promoted candidate's
 * compiled-truth line (with its source citation) and one timeline evidence
 * line to a canonical page, creating page metadata when the page is new.
 * Shared by the auto-promote gate and the `remember` one-call write.
 */
export function buildCanonicalCandidatePagePatch(
  page: Page | null,
  slug: string,
  candidate: MemoryCandidateEntry,
  options: CanonicalCandidatePagePatchOptions,
): Record<string, unknown> {
  const citation = sourceCitation(candidate.source_refs);
  const compiledLine = `${candidate.proposed_content.trim()} ${citation}`.trim();
  const compiledTruth = appendUniqueLine(page?.compiled_truth ?? '', compiledLine);
  const timelineLine = `- **${options.now.slice(0, 10)}** | ${options.timelineNote} ${citation}`;
  const timeline = appendUniqueLine(page?.timeline ?? '', timelineLine);
  return {
    type: page?.type ?? inferPageType(slug),
    title: page?.title ?? inferTitle(slug),
    frontmatter: page?.frontmatter ?? {},
    compiled_truth: compiledTruth,
    timeline,
  };
}

function appendUniqueLine(existing: string, line: string): string {
  const trimmedExisting = existing.trim();
  const trimmedLine = line.trim();
  if (!trimmedLine) return trimmedExisting;
  if (!trimmedExisting) return trimmedLine;
  if (trimmedExisting.includes(trimmedLine)) return trimmedExisting;
  return `${trimmedExisting}\n\n${trimmedLine}`;
}

function sourceCitation(sourceRefs: string[]): string {
  const refs = sourceRefs.map((ref) => normalizeSourceRef(ref)).filter(Boolean);
  const ref = refs[0] ?? 'mbrain:governed_write';
  return `[Source: ${ref}]`;
}

function normalizeSourceRef(ref: string): string {
  return ref.trim().replace(/^\[?Source:\s*/i, '').replace(/\]$/u, '').trim();
}

function inferPageType(slug: string): PageType {
  const normalized = `/${slug.toLowerCase()}/`;
  if (normalized.includes('/people/')) return 'person';
  if (normalized.includes('/companies/')) return 'company';
  if (normalized.includes('/deals/')) return 'deal';
  if (normalized.includes('/yc/')) return 'yc';
  if (normalized.includes('/civic/')) return 'civic';
  if (normalized.includes('/projects/')) return 'project';
  if (normalized.includes('/systems/')) return 'system';
  if (normalized.includes('/sources/')) return 'source';
  if (normalized.includes('/media/')) return 'media';
  return 'concept';
}

function inferTitle(slug: string): string {
  const last = slug.split('/').filter(Boolean).at(-1) ?? slug;
  return last
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
