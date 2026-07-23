/**
 * v0.29.1 — Compute a page's effective_date from frontmatter precedence.
 * tasks-41o — added the content_created_at / frontmatter.created rungs.
 *
 * The "effective date" is the answer to "when was this page about?" It's
 * NOT updated_at (which churns from auto-link) and NOT created_at (which
 * is the row insert time). It's the user's stated content date.
 *
 * Precedence chain (default order):
 *   1. frontmatter.event_date    — meeting / event pages
 *   2. frontmatter.date          — dated essays
 *   3. frontmatter.published     — writing/
 *   4. filename-date             — leading YYYY-MM-DD in basename
 *   5. content_created_at        — the pages.content_created_at column (see
 *                                   PageInput.content_created_at). Both
 *                                   in-tree writers derive it from
 *                                   frontmatter.created, so it ranks WITH
 *                                   that signal — just above it, because a
 *                                   persisted column survives a later
 *                                   frontmatter edit that drops the key.
 *                                   Ranking it above event_date/date/
 *                                   published would let a generic `created`
 *                                   stamp silently flip effective_date on
 *                                   every reindex of a page that also
 *                                   carries a deliberate date field.
 *   6. frontmatter.created       — generic "content created" signal (e.g.
 *                                   wiki/entities/ pages with no
 *                                   event_date/date/published/filename
 *                                   date). Ranked below the dedicated
 *                                   content-date fields above because those
 *                                   are deliberate, page-type-specific
 *                                   signals; `created` is a broader,
 *                                   weaker one used as a last resort before
 *                                   falling back to row bookkeeping.
 *   7. updated_at                — fallback
 *   8. created_at                — last resort (only if updated_at NULL)
 *
 * Per-prefix override: for `daily/` and `meetings/` slug prefixes, the
 * filename-date jumps to position 1 — the filename is the user's primary
 * signal there ("daily/2024-03-15.md" the FILE date matters more than any
 * frontmatter the user pasted).
 *
 * Returns BOTH the parsed Date and the source label so the doctor's
 * `effective_date_health` check can detect "fell back to updated_at" rows
 * that look populated but are functionally equivalent to a NULL.
 *
 * Range validation: parsed value must be in [1990-01-01, NOW + 1 year].
 * Out-of-range values are dropped (the chain falls through to the next
 * element). NaN / unparseable strings drop the same way.
 *
 * Pure function. No DB. Tested in test/effective-date.test.ts.
 */

import type { EffectiveDateSource } from './types.ts';

export interface EffectiveDateResult {
  date: Date | null;
  source: EffectiveDateSource | null;
}

export interface ComputeEffectiveDateOpts {
  slug: string;
  frontmatter: Record<string, unknown>;
  /** Basename without extension, e.g. "2024-03-15-acme-call". May be null/empty. */
  filename?: string | null;
  updatedAt: Date;
  createdAt: Date;
  /**
   * tasks-41o: the page's `content_created_at` column value (or an
   * importer-computed value before the row exists). Ranks just above the
   * frontmatter.created rung — see the module doc comment. Optional/
   * undefined for pre-migration callers; treated the same as null.
   */
  contentCreatedAt?: Date | null;
}

/**
 * Slug prefixes where the filename date wins over frontmatter dates. The
 * user's primary signal in these directories is the filename, not arbitrary
 * frontmatter the importer might have copied.
 *
 * Hardcoded in v0.29.1 (commit 2). v0.29.1 commit 5 introduces the
 * recency-decay map; we could move this list there if we wanted user-tunable
 * filename-first prefixes, but the daily/ + meetings/ defaults are stable
 * enough that hardcoding is correct.
 */
const FILENAME_FIRST_PREFIXES = ['daily/', 'meetings/'];

const MIN_DATE_MS = Date.UTC(1990, 0, 1);
const FILENAME_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

function maxDateMs(): number {
  // NOW + 1 year, computed at call time so tests with a mocked Date.now()
  // see a moving boundary. Pages dated > 1 year in the future are almost
  // always corrupt (epoch math gone wrong, typoed century, bad parse).
  return Date.now() + 365 * 24 * 60 * 60 * 1000;
}

/** Parse a frontmatter value as a Date. Accepts Date instances, ISO strings, YYYY-MM-DD. Returns null on any failure. */
export function parseDateLoose(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
  }
  if (typeof value === 'number') {
    // Plausibility: numbers are usually ms since epoch but YAML can yield
    // bare integers (year? month? day?) — accept only if the resulting Date
    // falls inside the valid window. validateInRange catches the rest.
    return Number.isFinite(value) ? new Date(value) : null;
  }
  return null;
}

function validateInRange(d: Date | null): Date | null {
  if (d === null) return null;
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < MIN_DATE_MS) return null;
  if (ms > maxDateMs()) return null;
  return d;
}

function extractFilenameDate(filename: string | null | undefined): Date | null {
  if (!filename) return null;
  const m = filename.match(FILENAME_DATE_RE);
  if (!m) return null;
  return validateInRange(parseDateLoose(m[1]));
}

function hasFilenameFirstPrefix(slug: string): boolean {
  for (const p of FILENAME_FIRST_PREFIXES) {
    if (slug.startsWith(p)) return true;
  }
  return false;
}

/**
 * Run the precedence chain. Returns the first valid (in-range) date and its
 * source label. Falls all the way through to updated_at / created_at as
 * 'fallback' when nothing in frontmatter or filename parses.
 */
export function computeEffectiveDate(opts: ComputeEffectiveDateOpts): EffectiveDateResult {
  const { slug, frontmatter, filename, updatedAt, createdAt, contentCreatedAt } = opts;
  const filenameFirst = hasFilenameFirstPrefix(slug);

  // tasks-41o: the persisted pages.content_created_at column. Derived from
  // frontmatter.created by every in-tree writer, so it ranks WITH that
  // signal (just above it — the column survives a frontmatter edit that
  // drops the key). See the module doc comment.
  const contentCreated = validateInRange(contentCreatedAt ?? null);

  const fmEvent = validateInRange(parseDateLoose(frontmatter.event_date));
  const fmDate = validateInRange(parseDateLoose(frontmatter.date));
  const fmPublished = validateInRange(parseDateLoose(frontmatter.published));
  const filenameDate = extractFilenameDate(filename);
  // tasks-41o: generic "content created" signal — weaker than the
  // page-type-specific fields above, so it's ranked last before the
  // updated_at/created_at fallback tier (see module doc comment).
  const fmCreated = validateInRange(parseDateLoose(frontmatter.created));

  // Build the ordered candidate list. For filename-first prefixes
  // (daily/, meetings/) the filename moves to the head of the chain.
  const candidates: Array<{ date: Date | null; source: EffectiveDateSource }> = filenameFirst
    ? [
        { date: filenameDate, source: 'filename' },
        { date: fmEvent, source: 'event_date' },
        { date: fmDate, source: 'date' },
        { date: fmPublished, source: 'published' },
        { date: contentCreated, source: 'content_created_at' },
        { date: fmCreated, source: 'created' },
      ]
    : [
        { date: fmEvent, source: 'event_date' },
        { date: fmDate, source: 'date' },
        { date: fmPublished, source: 'published' },
        { date: filenameDate, source: 'filename' },
        { date: contentCreated, source: 'content_created_at' },
        { date: fmCreated, source: 'created' },
      ];

  for (const c of candidates) {
    if (c.date !== null) return { date: c.date, source: c.source };
  }

  // Fallback chain: updated_at, then created_at. Both are guaranteed
  // non-null by the schema; the validation here is defensive against bad
  // test fixtures.
  const upd = validateInRange(updatedAt);
  if (upd !== null) return { date: upd, source: 'fallback' };
  const cre = validateInRange(createdAt);
  if (cre !== null) return { date: cre, source: 'fallback' };

  return { date: null, source: null };
}
