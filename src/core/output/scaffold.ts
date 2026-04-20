/**
 * Scaffolder — deterministic URL / citation / link builders.
 *
 * The anti-hallucination invariant: LLM picks WHAT to write. Code builds
 * WHERE and HOW. Every user-visible URL, every citation, every wikilink is
 * assembled from resolver outputs or structured IDs — never from LLM text.
 *
 * Example (from the Wintermute memory log, 2026-04-13): an agent was asked
 * to rewrite daily files and it invented a "Philip Leung" entity that didn't
 * exist. With the Scaffolder, the LLM writes "the attendee was mentioned
 * again" and code writes the actual `[Philip Leung](people/philip-leung.md)`
 * from the verified resolver result. If the slug doesn't exist, Scaffolder
 * throws instead of rendering a broken link.
 *
 * This file is pure and has no runtime deps beyond the engine handle passed
 * through SlugRegistry. It's trivially testable.
 */

import type { ResolverResult } from '../resolvers/interface.ts';

// ---------------------------------------------------------------------------
// Tweet citations
// ---------------------------------------------------------------------------

export interface TweetCitationInput {
  /** X handle without leading @. */
  handle: string;
  tweetId: string;
  /** ISO date for the "X/{handle}, YYYY-MM-DD" label. Uses today if omitted. */
  dateISO?: string;
}

/**
 * Build the canonical tweet citation:
 *   [Source: [X/garrytan, 2026-04-18](https://x.com/garrytan/status/1234567890)]
 *
 * The URL is constructed from (handle, tweetId) — both are typed, neither is
 * free text. If either is malformed, throws ScaffoldError before rendering.
 */
export function tweetCitation(input: TweetCitationInput): string {
  assertHandle(input.handle);
  assertTweetId(input.tweetId);
  const date = input.dateISO ?? isoDateToday();
  assertISODate(date);
  const handle = input.handle.replace(/^@/, '');
  const url = `https://x.com/${handle}/status/${input.tweetId}`;
  return `[Source: [X/${handle}, ${date}](${url})]`;
}

// ---------------------------------------------------------------------------
// Gmail citations
// ---------------------------------------------------------------------------

export interface EmailCitationInput {
  /** Which Gmail account (e.g. "garry@ycombinator.com") for the authuser URL. */
  account: string;
  /** Gmail message id (hex); comes from API response. */
  messageId: string;
  /** Subject for the label; free text, trimmed + truncated. */
  subject: string;
  dateISO?: string;
}

/**
 * Canonical email citation with a deep link that opens the actual thread:
 *   [Source: email "Subject line", 2026-04-18](https://mail.google.com/mail/u/?authuser=...#inbox/...)
 *
 * URL shape matches the pattern Wintermute's ingest pipeline builds from API
 * responses, so brain-page links and agent-generated links use the same
 * format (cross-tool consistency).
 */
export function emailCitation(input: EmailCitationInput): string {
  assertNonEmpty(input.account, 'account');
  assertMessageId(input.messageId);
  const subject = sanitizeLabel(input.subject, 80);
  const date = input.dateISO ?? isoDateToday();
  assertISODate(date);
  const url = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(input.account)}#inbox/${input.messageId}`;
  return `[Source: email "${subject}", ${date}](${url})`;
}

// ---------------------------------------------------------------------------
// Generic resolver-backed citation
// ---------------------------------------------------------------------------

/**
 * Build a citation from a ResolverResult. Useful for sources that don't have
 * a dedicated helper above (Perplexity query, Mistral OCR, etc.).
 *
 * Output:
 *   [Source: perplexity-sonar, 2026-04-18](https://url-from-raw-if-any)
 *
 * If the resolver didn't return a resolvable URL and one isn't provided,
 * the citation still renders with just source + date, so it's honest about
 * what we can link to.
 */
export function sourceCitation(
  result: Pick<ResolverResult<unknown>, 'source' | 'fetchedAt'>,
  opts?: { url?: string; label?: string },
): string {
  const date = result.fetchedAt.toISOString().slice(0, 10);
  const label = opts?.label ?? result.source;
  if (opts?.url) {
    return `[Source: [${label}, ${date}](${opts.url})]`;
  }
  return `[Source: ${label}, ${date}]`;
}

// ---------------------------------------------------------------------------
// Entity wikilinks
// ---------------------------------------------------------------------------

export interface EntityLinkInput {
  /** Slug in dir/name form, e.g. "people/alice-smith". */
  slug: string;
  /** Display text for the link. Trimmed. */
  displayText: string;
  /**
   * Relative path prefix. Usually "../../" from a daily file up to brain
   * root; caller knows its depth. Default is no prefix (absolute-from-brain).
   */
  relativePrefix?: string;
}

/**
 * Build a brain-internal wikilink:
 *   [Alice Smith](../../people/alice-smith.md)
 *
 * Does NOT verify the slug exists here — that's the SlugRegistry's job at
 * BrainWriter commit time. Scaffolder just renders the bytes.
 */
export function entityLink(input: EntityLinkInput): string {
  assertSlug(input.slug);
  const display = sanitizeLabel(input.displayText, 120);
  const prefix = input.relativePrefix ?? '';
  return `[${display}](${prefix}${input.slug}.md)`;
}

// ---------------------------------------------------------------------------
// Timeline entry line
// ---------------------------------------------------------------------------

export interface TimelineLineInput {
  dateISO: string;
  summary: string;
  /** Pre-built citation string (use tweetCitation/emailCitation/sourceCitation). */
  citation?: string;
}

/**
 * Canonical timeline entry line:
 *   - **2026-04-18** | Summary here [Source: ...]
 */
export function timelineLine(input: TimelineLineInput): string {
  assertISODate(input.dateISO);
  const summary = sanitizeLabel(input.summary, 500);
  const cite = input.citation ? ` ${input.citation}` : '';
  return `- **${input.dateISO}** | ${summary}${cite}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ScaffoldError extends Error {
  constructor(public code: 'invalid_handle' | 'invalid_tweet_id' | 'invalid_slug' | 'invalid_message_id' | 'invalid_date' | 'empty', message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

// X handle: 1-15 chars, alphanumeric + underscore. Optional leading @ allowed.
const HANDLE_RE = /^@?[A-Za-z0-9_]{1,15}$/;
function assertHandle(h: unknown): asserts h is string {
  if (typeof h !== 'string' || !HANDLE_RE.test(h)) {
    throw new ScaffoldError('invalid_handle', `Invalid X handle: ${JSON.stringify(h)}`);
  }
}

// Tweet id: 1-20 digits (X snowflake ids).
const TWEET_ID_RE = /^\d{1,20}$/;
function assertTweetId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !TWEET_ID_RE.test(id)) {
    throw new ScaffoldError('invalid_tweet_id', `Invalid tweet id: ${JSON.stringify(id)}`);
  }
}

// Gmail message id: hex string, at least 10 chars.
const MESSAGE_ID_RE = /^[A-Za-z0-9]{10,60}$/;
function assertMessageId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !MESSAGE_ID_RE.test(id)) {
    throw new ScaffoldError('invalid_message_id', `Invalid Gmail message id: ${JSON.stringify(id)}`);
  }
}

// Slug: dir/name with allowed characters. Matches PageType dir conventions.
const SLUG_RE = /^[a-z0-9][a-z0-9\-]*(\/[a-z0-9][a-z0-9\-]*)+$/;
function assertSlug(slug: unknown): asserts slug is string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new ScaffoldError('invalid_slug', `Invalid slug: ${JSON.stringify(slug)}`);
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertISODate(d: unknown): asserts d is string {
  if (typeof d !== 'string' || !ISO_DATE_RE.test(d)) {
    throw new ScaffoldError('invalid_date', `Invalid ISO date (expect YYYY-MM-DD): ${JSON.stringify(d)}`);
  }
}

function assertNonEmpty(s: unknown, field: string): asserts s is string {
  if (typeof s !== 'string' || s.length === 0) {
    throw new ScaffoldError('empty', `Required field ${field} must be a non-empty string`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Trim, strip newlines/brackets that would break markdown, cap length. */
function sanitizeLabel(s: string, maxLen: number): string {
  return s
    .replace(/[\n\r]/g, ' ')
    .replace(/[\[\]]/g, '')
    .trim()
    .slice(0, maxLen);
}
