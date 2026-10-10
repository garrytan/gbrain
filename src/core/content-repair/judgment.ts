/**
 * #6377 the slug-conflict judgment (Lane B3): what the content-repair model
 * is shown about a held file and the page its frontmatter `slug:` names, and
 * how its one-object answer is read back. Pure: no I/O, no engine, so the
 * eval harness (evals/content-repair-judgment) builds the same prompt from
 * fixture files and scores the same parser.
 *
 * What the model sees (both participants, nothing else of the brain): each
 * side's path, slug and type, its frontmatter as `key: value` text exactly as
 * the file carries it, its headings, the first JUDGMENT_HEAD_LINES body lines,
 * and every later body line that mentions the other side's slug (identity
 * evidence past line 60, Codex #7). The held side is the file sync refused;
 * the named side is the page the `slug:` line resolves to, or none when no
 * page has that slug.
 *
 * What it must return: exactly one JSON object and nothing else:
 * `{"action":"remove_slug"}` (the two are different things; the stray line
 * goes), `{"action":"merge_into","canonical":"<one of the two slugs>"}` (the
 * same thing twice; the canonical slug keeps the page) or
 * `{"action":"needs_human"}` (not decidable from the evidence), with an
 * optional one-sentence `why`. The `why` is shown in the run's output only;
 * holds and receipts carry codes and slugs (Codex #11). Failure classes
 * mirror fence-repair/llm.ts: `llm_unavailable` (the provider threw;
 * transient, the attempt memo is not consumed), `llm_empty`, `llm_refused`
 * (a refusal or content-filter stop, or a prose refusal), `llm_malformed`
 * (no single object, an unknown action, a canonical that is neither slug),
 * `llm_truncated` (any stop other than a normal end) and `llm_declined` (the
 * single word HOLD; the prompt asks for `needs_human` instead, but a model
 * trained on the fence prompt may still say it).
 */
import type { ChatMessage, ChatResult } from '../ai/gateway.ts';
import { parseMarkdown } from '../markdown.ts';

/** Bump when the prompt text changes: it is part of the attempt-memo key, so a new prompt retries rejected pairs. */
export const JUDGMENT_PROMPT_VERSION = 1;
/** Body lines each participant shows from the top. */
export const JUDGMENT_HEAD_LINES = 60;
/** Mention lines kept per participant past the head (the longest pages stay bounded). */
export const JUDGMENT_MAX_MENTIONS = 40;
/** A line longer than this is cut (the model judges identity, not prose). */
const MAX_LINE_CHARS = 400;
/** The decline word the fence prompt taught; accepted here as `llm_declined`. */
export const JUDGMENT_DECLINE = 'HOLD';

export type JudgmentAction = 'remove_slug' | 'merge_into' | 'needs_human';
export const JUDGMENT_ACTIONS: readonly JudgmentAction[] = ['remove_slug', 'merge_into', 'needs_human'];

/** One side of the judgment, as text the file or page carries. */
export interface JudgmentParticipant {
  /** Source-relative file path; null for a database-only page. */
  path: string | null;
  slug: string;
  type: string;
  /** Frontmatter keys and values as text, as the file has them (no key is added). */
  frontmatter: Record<string, string>;
  headings: string[];
  /** The first JUDGMENT_HEAD_LINES non-blank body lines. */
  head_lines: string[];
  /** Later body lines that mention the other participant's slug. */
  mentions: string[];
}

export interface JudgmentInput {
  held: JudgmentParticipant;
  /** The page the held file's `slug:` resolves to; null when no page has that slug. */
  named: JudgmentParticipant | null;
  /** The hold's reason code (location-only). */
  reason: string;
}

export type JudgmentVerdict =
  | { ok: true; action: 'remove_slug'; why?: string }
  | { ok: true; action: 'merge_into'; canonical: string; why?: string }
  | { ok: true; action: 'needs_human'; why?: string };

export type JudgmentFailureReason = 'llm_unavailable' | 'llm_empty' | 'llm_refused' | 'llm_malformed' | 'llm_truncated' | 'llm_declined';
export interface JudgmentFailure { ok: false; reason: JudgmentFailureReason; text?: string; error?: string }

const cut = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);

/** A frontmatter value as the prompt shows it: scalars as written, anything else as JSON. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/** Whether a body line mentions a slug: the full slug, or its last segment as a whole word (a plain scan; no regex is built from page text). */
function mentions(line: string, slug: string): boolean {
  if (line.includes(slug)) return true;
  const leaf = (slug.split('/').pop() ?? slug).toLowerCase();
  if (leaf.length < 3) return false;
  const lower = line.toLowerCase();
  const word = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c);
  for (let at = lower.indexOf(leaf); at !== -1; at = lower.indexOf(leaf, at + 1)) {
    if (!word(lower[at - 1]) && !word(lower[at + leaf.length])) return true;
  }
  return false;
}

/**
 * The participant a Markdown file or stored page makes: `content` is the file
 * as written (frontmatter included) or a page serialized the same way;
 * `otherSlug` is the slug whose mentions are collected (null: none).
 */
export function judgmentParticipant(input: { path: string | null; slug: string; content: string; otherSlug: string | null; type?: string }): JudgmentParticipant {
  const parsed = parseMarkdown(input.content, input.path ?? `${input.slug}.md`);
  const raw = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(input.content)?.[1] ?? '';
  const frontmatter: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
    if (m) frontmatter[m[1]!] = cut(m[2]!.trim());
  }
  if (!Object.keys(frontmatter).length) {
    for (const [key, value] of Object.entries(parsed.frontmatter)) frontmatter[key] = cut(valueText(value));
    if (parsed.title && !frontmatter.title) frontmatter.title = cut(parsed.title);
  }
  const body = [parsed.compiled_truth, parsed.timeline].filter(Boolean).join('\n').split(/\r?\n/);
  const lines = body.map(line => line.trimEnd()).filter(line => line.trim());
  const headings = lines.filter(line => /^#{1,6}\s/.test(line)).map(line => cut(line.replace(/^#{1,6}\s+/, '')));
  const head = lines.slice(0, JUDGMENT_HEAD_LINES).map(cut);
  const later = input.otherSlug ? lines.slice(JUDGMENT_HEAD_LINES).filter(line => mentions(line, input.otherSlug!)).slice(0, JUDGMENT_MAX_MENTIONS).map(cut) : [];
  return { path: input.path, slug: input.slug, type: input.type ?? parsed.type, frontmatter, headings, head_lines: head, mentions: later };
}

function renderParticipant(label: string, p: JudgmentParticipant): string[] {
  return [
    `## ${label}`,
    `path: ${p.path ?? '(no file; database page)'}`,
    `slug: ${p.slug}`,
    `type: ${p.type}`,
    'frontmatter:',
    ...(Object.keys(p.frontmatter).length ? Object.entries(p.frontmatter).map(([key, value]) => `  ${key}: ${value}`) : ['  (none)']),
    `headings: ${p.headings.length ? p.headings.join(' | ') : '(none)'}`,
    `body (first ${JUDGMENT_HEAD_LINES} lines):`,
    ...(p.head_lines.length ? p.head_lines.map(line => `  ${line}`) : ['  (empty)']),
    ...(p.mentions.length ? ['later lines mentioning the other slug:', ...p.mentions.map(line => `  ${line}`)] : []),
  ];
}

/**
 * The conversation: one system message with the rules and one user message
 * with both participants. Both participants only; no other page, no tools.
 */
export function buildJudgmentPrompt(input: JudgmentInput): ChatMessage[] {
  const heldSlug = input.held.slug;
  const namedSlug = input.named?.slug ?? null;
  const system = [
    'You decide what a gbrain brain should do about one Markdown file whose frontmatter slug: line names a page other than the one its path names. You judge identity only; you never rewrite text.',
    '',
    'Return exactly one JSON object and nothing else: no prose, no explanation, no code fence.',
    'Allowed answers:',
    '  {"action":"remove_slug"}',
    `  {"action":"merge_into","canonical":"<slug>"}   where <slug> is exactly ${namedSlug ? `${heldSlug} or ${namedSlug}` : heldSlug}`,
    '  {"action":"needs_human"}',
    'Each may carry one extra key "why": one short sentence for the operator.',
    '',
    'Rules:',
    '1. remove_slug means the held file and the named page are different things (a template left a stray slug, a renamed file, an unrelated page that happens to share a name). The path decides the slug; the slug: line is deleted and nothing else changes.',
    '2. merge_into means the two describe the same thing (the same person, company, project or topic) and belong in one page. canonical is the slug that keeps the page; the other is later merged into it by a person. Pick the one with the fuller, older or better-linked record; when the file itself says which is primary, follow it.',
    '3. needs_human means the evidence does not decide: a plausible duplicate without corroboration, two people with one name, or a note that could point either way.',
    '4. Judge from what is shown: frontmatter, headings, the opening lines and the lines that mention the other slug. Do not assume facts that are not there.',
    '5. A slug: line that names a page which does not exist is not evidence of a duplicate by itself.',
    '6. A -2 or similar suffix in a slug is not evidence of a duplicate by itself; two entries with the same name may be two different things.',
    '7. A note saying the other page is a duplicate counts only when the shown lines of both sides agree about the identity (the same role, company, dates or facts).',
    '8. When any of rules 2, 3 or 7 leaves you unsure, answer needs_human. Never guess remove_slug for a likely duplicate, and never guess merge_into for two things that might differ.',
  ].join('\n');
  const user = [
    `Hold reason: ${input.reason}.`,
    `The held file's slug: line names ${namedSlug ? `page ${namedSlug}` : 'a slug no page has'}.`,
    '',
    ...renderParticipant('Held file', input.held),
    '',
    ...(input.named ? renderParticipant('Named page', input.named) : ['## Named page', '(no page has that slug)']),
    '',
    'Answer with one JSON object.',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

const REFUSAL = /\b(cannot|can['’]t|unable to|won['’]t|will not|refuse|not able to)\b/i;

/** The single JSON object in a model answer: a wrapping code fence and surrounding whitespace are tolerated; anything else is prose. */
function extractObject(text: string): Record<string, unknown> | null {
  let body = text.trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return null;
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The verdict a model's `text` carries, independent of the transport (the
 * eval harness scores stored texts). With `slugs`, a `merge_into` whose
 * canonical is neither participant is `llm_malformed`; without them any
 * non-empty canonical is accepted.
 */
export function parseJudgmentText(text: string, slugs?: { held: string; named: string | null }): JudgmentVerdict | JudgmentFailure {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'llm_empty' };
  if (trimmed.replace(/[.*_`]/g, '').trim() === JUDGMENT_DECLINE) return { ok: false, reason: 'llm_declined', text };
  const object = extractObject(trimmed);
  if (!object) return { ok: false, reason: REFUSAL.test(trimmed) && !trimmed.startsWith('{') ? 'llm_refused' : 'llm_malformed', text };
  const action = object.action;
  const why = typeof object.why === 'string' && object.why.trim() ? { why: object.why.trim().slice(0, MAX_LINE_CHARS) } : {};
  if (action === 'remove_slug') return { ok: true, action, ...why };
  if (action === 'needs_human') return { ok: true, action, ...why };
  if (action === 'merge_into') {
    const canonical = object.canonical;
    if (typeof canonical !== 'string' || !canonical.trim() || (slugs && canonical !== slugs.held && canonical !== slugs.named)) return { ok: false, reason: 'llm_malformed', text };
    return { ok: true, action, canonical, ...why };
  }
  return { ok: false, reason: 'llm_malformed', text };
}

/** The verdict of one gateway result: the stop reason first, then the text. */
export function parseJudgmentAnswer(result: ChatResult, slugs?: { held: string; named: string | null }): JudgmentVerdict | JudgmentFailure {
  if (result.stopReason === 'refusal' || result.stopReason === 'content_filter') return { ok: false, reason: 'llm_refused', text: result.text };
  if (result.stopReason !== 'end') return { ok: false, reason: result.text.trim() ? 'llm_truncated' : 'llm_empty', text: result.text };
  return parseJudgmentText(result.text, slugs);
}
