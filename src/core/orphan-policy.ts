/**
 * Shared orphan-reporting exclusion policy.
 *
 * These are pages where "no inbound links" is expected and should not count
 * against health. Keep this in core so the CLI orphan report and engine health
 * dashboard cannot drift.
 *
 * Defaults are GBrain-wide conventions only. Brain-specific exclusions
 * (private folder names, one-off fixture slugs) belong in the brain's own
 * config, not here:
 *
 *   foresights config set orphans.exclude_prefixes "my-private-folder/,archive/"
 *   foresights config set orphans.exclude_slugs "some-one-off-page"
 *
 * One policy, two renderers: `shouldExcludeFromOrphanReporting` (TypeScript,
 * one slug at a time) and `orphanExclusionSql` (a SQL predicate for set-wise
 * aggregates such as get_health). Both read the constants below;
 * `test/orphan-policy-sql-parity.test.ts` keeps them equal on generated slugs.
 */

import { joinFragments, sqlFragment, trustedSql, type SqlFragment } from './engine-sql/fragment.ts';

// '/readme' — a README is a folder descriptor, not a knowledge node;
// nothing is expected to wikilink to it.
const AUTO_SUFFIX_PATTERNS = ['/_index', '/log', '/readme'];

// 'readme' / 'index' — root-level folder descriptors, same rationale as the
// '/readme' suffix. 'schema' — written by the schema pack on init; 'log' —
// the root brain log.
const PSEUDO_SLUGS = new Set(['_atlas', '_index', '_stats', '_orphans', '_scratch', 'claude', 'readme', 'index', 'schema', 'log']);

const RAW_SEGMENT = '/raw/';

const DENY_PREFIXES = [
  'output/',
  'outputs/',
  'dashboards/',
  'scripts/',
  'templates/',
  '_templates/',
  'openclaw/config/',
  'extracts/',
  // auto_chronicle event volume (life/events/<day>-<hash>) — machine leaf, no
  // inbound links by design. Deny-prefix (not whole `life/` first-segment) so
  // human-authored life/diary/ stays IN the orphan denominator. (#2264)
  'life/events/',
];

const FIRST_SEGMENT_EXCLUSIONS = new Set([
  'scratch',
  'thoughts',
  'catalog',
  'entities',
  'raw',
  'atoms',
  'skills',
  'dreaming',
  'daily',
  // 'inbox' — GTD-style intake tray: dated collector records in transit
  // (email digests, alerts) awaiting triage; nothing links INTO an inbox
  // item, same rationale as 'daily'.
  'inbox',
]);

const ROOT_DATE_SLUG = /^\d{4}-\d{2}-\d{2}(?:-.+)?$/;
// SQL (ARE) twin of ROOT_DATE_SLUG: JS `\d` is ASCII-only and `.` stops at
// line terminators, so both are spelled out explicitly.
const ROOT_DATE_SLUG_SQL = '^[0123456789]{4}-[0123456789]{2}-[0123456789]{2}(-[^\\n\\r\\u2028\\u2029]+)?$';

const DAILY_SEGMENT = '/daily/';
const BRAIN_PREFIX = '_brain-';
const AGENTS_PREFIX = 'agents/';
const AGENT_DREAMING_SEGMENT = '/memory/dreaming/';
const AGENT_WORKSPACE_FILES = ['agents', 'identity', 'soul', 'tools', 'user', 'heartbeat', 'dreams', 'dormant'];
const AGENT_WORKSPACE_FILE = new RegExp(`^agents/[^/]+/(?:${AGENT_WORKSPACE_FILES.join('|')})$`);
const AGENT_WORKSPACE_FILE_SQL = `^agents/[^/]+/(${AGENT_WORKSPACE_FILES.join('|')})$`;

function isAgentWorkspaceConvention(slug: string): boolean {
  if (!slug.startsWith(AGENTS_PREFIX)) return false;
  if (slug.includes(AGENT_DREAMING_SEGMENT)) return true;
  return AGENT_WORKSPACE_FILE.test(slug);
}

/** Per-brain additions to the convention defaults (from config). */
export interface OrphanPolicyOverrides {
  excludePrefixes?: string[];
  excludeSlugs?: string[];
}

/**
 * Optional page metadata for exclusions slug conventions cannot infer
 * (#4280): a quarantined shell or a machine leaf-type page is intentionally
 * disconnected, not a broken knowledge node.
 */
export interface OrphanPageMeta {
  type?: string | null;
  quarantined?: boolean;
}

/** Machine leaf types — expected to be leaf-shaped regardless of slug. */
const NON_LINKABLE_PAGE_TYPES = new Set(['atom', 'conversation', 'source']);

/** Config keys for per-brain orphan exclusions (comma-separated values). */
export const ORPHAN_EXCLUDE_PREFIXES_KEY = 'orphans.exclude_prefixes';
export const ORPHAN_EXCLUDE_SLUGS_KEY = 'orphans.exclude_slugs';

function parseList(value: string | null): string[] {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Load per-brain orphan exclusions from the brain config table. Callers with
 * an engine in hand (getHealth, `foresights orphans`) pass the result as the
 * second argument to shouldExcludeFromOrphanReporting.
 */
export async function loadOrphanPolicyOverrides(
  engine: { getConfig(key: string): Promise<string | null> },
): Promise<OrphanPolicyOverrides> {
  const [prefixes, slugs] = await Promise.all([
    engine.getConfig(ORPHAN_EXCLUDE_PREFIXES_KEY),
    engine.getConfig(ORPHAN_EXCLUDE_SLUGS_KEY),
  ]);
  return { excludePrefixes: parseList(prefixes), excludeSlugs: parseList(slugs) };
}

export function shouldExcludeFromOrphanReporting(
  slug: string,
  overrides?: OrphanPolicyOverrides,
  meta?: OrphanPageMeta,
): boolean {
  if (meta?.quarantined === true) return true;
  if (meta?.type && NON_LINKABLE_PAGE_TYPES.has(meta.type)) return true;
  if (PSEUDO_SLUGS.has(slug)) return true;

  for (const suffix of AUTO_SUFFIX_PATTERNS) {
    if (slug.endsWith(suffix)) return true;
  }

  if (slug.includes(RAW_SEGMENT)) return true;
  if (slug.includes(DAILY_SEGMENT)) return true;

  for (const prefix of DENY_PREFIXES) {
    if (slug.startsWith(prefix)) return true;
  }

  const firstSegment = slug.split('/')[0];
  if (FIRST_SEGMENT_EXCLUSIONS.has(firstSegment)) return true;

  if (ROOT_DATE_SLUG.test(slug)) return true;

  if (slug.startsWith(BRAIN_PREFIX)) return true;

  if (isAgentWorkspaceConvention(slug)) return true;

  if (overrides) {
    if (overrides.excludeSlugs?.includes(slug)) return true;
    for (const prefix of overrides.excludePrefixes ?? []) {
      if (slug.startsWith(prefix)) return true;
    }
  }

  return false;
}

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * SQL renderer of `shouldExcludeFromOrphanReporting(slug, overrides, { type })`
 * over the pages row aliased `alias`: a boolean expression that is TRUE when
 * the row is excluded and never NULL. Every list (the convention constants and
 * the per-brain overrides) binds as a text[] parameter; only the alias, checked
 * against a plain-identifier pattern, is spliced. Quarantine is not part of
 * the predicate: SQL callers filter it with the quarantine fragment.
 */
export function orphanExclusionSql(alias: string, overrides?: OrphanPolicyOverrides): SqlFragment {
  if (!SQL_ALIAS.test(alias)) throw new Error(`orphanExclusionSql: alias must be a plain identifier, got ${JSON.stringify(alias)}`);
  const slug = trustedSql(`${alias}.slug`);
  const type = trustedSql(`${alias}.type`);
  // One comparison per list entry (OR-chained, each value a parameter): a
  // per-row unnest() subquery costs more than the whole remaining predicate.
  const anyOf = (values: readonly string[], test: (value: string) => SqlFragment) =>
    values.length === 0 ? sqlFragment`FALSE` : joinFragments(values.map(test), ' OR ');
  const suffix = (v: string) => sqlFragment`right(${slug}, ${v.length}::int) = ${v}::text`;
  const prefix = (v: string) => sqlFragment`starts_with(${slug}, ${v}::text)`;
  return sqlFragment`COALESCE((
    ${type} = ANY(${[...NON_LINKABLE_PAGE_TYPES]}::text[])
    OR ${slug} = ANY(${[...PSEUDO_SLUGS]}::text[])
    OR ${anyOf(AUTO_SUFFIX_PATTERNS, suffix)}
    OR strpos(${slug}, ${RAW_SEGMENT}::text) > 0
    OR strpos(${slug}, ${DAILY_SEGMENT}::text) > 0
    OR ${anyOf(DENY_PREFIXES, prefix)}
    OR split_part(${slug}, '/', 1) = ANY(${[...FIRST_SEGMENT_EXCLUSIONS]}::text[])
    OR ${slug} ~ ${ROOT_DATE_SLUG_SQL}::text
    OR starts_with(${slug}, ${BRAIN_PREFIX}::text)
    OR (starts_with(${slug}, ${AGENTS_PREFIX}::text)
        AND (strpos(${slug}, ${AGENT_DREAMING_SEGMENT}::text) > 0 OR ${slug} ~ ${AGENT_WORKSPACE_FILE_SQL}::text))
    OR ${slug} = ANY(${overrides?.excludeSlugs ?? []}::text[])
    OR ${anyOf(overrides?.excludePrefixes ?? [], prefix)}
  ), false)`;
}

/** #5828: the brain_score timeline component's graded subset of the linkable scope. */
export { gradeTimelinePages } from './timeline-grading.ts';
