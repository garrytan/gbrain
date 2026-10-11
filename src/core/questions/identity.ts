/**
 * Pinned-question identity: source-qualified ids (`<source_id>:<slug>`) and
 * deterministic slugs, so pinning the same question with the same scope twice
 * lands on the same row. Pure; no engine or runtime imports (the pinned-questions
 * schema migration handler imports it).
 */
import { createHash } from 'node:crypto';

export const QUESTION_SLUG_PREFIX = 'questions/';
export const QUESTION_PAGE_TYPE = 'question';
/** Frontmatter key that marks a page as a pinned question's page; forces it private for remote readers. */
export const PINNED_QUESTION_MARKER = 'pinned_question';
export const MAX_QUESTION_CHARS = 500;

export interface QuestionScope {
  source: string;
  slug_prefix?: string;
  entity?: string;
}

export function normalizeQuestion(question: string): string {
  return question.replace(/\s+/g, ' ').trim();
}

export function questionSlug(question: string, scope: QuestionScope): string {
  const norm = normalizeQuestion(question);
  const kebab = norm.toLowerCase().replace(/[^a-z0-9\s-]+/g, '').trim().replace(/[\s-]+/g, '-').slice(0, 60).replace(/-+$/, '') || 'question';
  const digest = createHash('sha256')
    .update([norm.toLowerCase(), scope.slug_prefix ?? '', scope.entity ?? ''].join('\n'))
    .digest('hex').slice(0, 8);
  return `${QUESTION_SLUG_PREFIX}${kebab}-${digest}`;
}

export function formatQuestionId(sourceId: string, slug: string): string {
  return `${sourceId}:${slug}`;
}

/** Parses `<source_id>:<slug>`; a bare slug resolves in `defaultSource`. Null when malformed. */
export function parseQuestionId(id: string, defaultSource: string): { sourceId: string; slug: string } | null {
  const raw = id.trim();
  const colon = raw.indexOf(':');
  const sourceId = colon > 0 ? raw.slice(0, colon) : defaultSource;
  const slug = colon > 0 ? raw.slice(colon + 1) : raw;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(sourceId)) return null;
  if (!slug.startsWith(QUESTION_SLUG_PREFIX) || !/^questions\/[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) return null;
  return { sourceId, slug };
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable sentence id from its text: keeps citations attached across rewrites that leave a sentence unchanged. */
export function sentenceId(text: string): string {
  return `s_${sha256Hex(normalizeQuestion(text).toLowerCase()).slice(0, 12)}`;
}
