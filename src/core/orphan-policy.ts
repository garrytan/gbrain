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
 *   gbrain config set orphans.exclude_prefixes "my-private-folder/,archive/"
 *   gbrain config set orphans.exclude_slugs "some-one-off-page"
 */

const AUTO_SUFFIX_PATTERNS = ['/_index', '/log'];

const PSEUDO_SLUGS = new Set(['_atlas', '_index', '_stats', '_orphans', '_scratch', 'claude']);

const RAW_SEGMENT = '/raw/';

const DENY_PREFIXES = [
  'output/',
  'dashboards/',
  'scripts/',
  'templates/',
  '_templates/',
  'openclaw/config/',
  'extracts/',
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
]);

const ROOT_DATE_SLUG = /^\d{4}-\d{2}-\d{2}(?:-.+)?$/;

function isAgentWorkspaceConvention(slug: string): boolean {
  if (!slug.startsWith('agents/')) return false;
  if (slug.includes('/memory/dreaming/')) return true;
  return /^agents\/[^/]+\/(?:agents|identity|soul|tools|user|heartbeat|dreams|dormant)$/.test(slug);
}

/** Per-brain additions to the convention defaults (from config). */
export interface OrphanPolicyOverrides {
  excludePrefixes?: string[];
  excludeSlugs?: string[];
}

/** Config keys for per-brain orphan exclusions (comma-separated values). */
export const ORPHAN_EXCLUDE_PREFIXES_KEY = 'orphans.exclude_prefixes';
export const ORPHAN_EXCLUDE_SLUGS_KEY = 'orphans.exclude_slugs';

function parseList(value: string | null): string[] {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Load per-brain orphan exclusions from the brain config table. Callers with
 * an engine in hand (getHealth, `gbrain orphans`) pass the result as the
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
): boolean {
  if (PSEUDO_SLUGS.has(slug)) return true;

  for (const suffix of AUTO_SUFFIX_PATTERNS) {
    if (slug.endsWith(suffix)) return true;
  }

  if (slug.includes(RAW_SEGMENT)) return true;
  if (slug.includes('/daily/')) return true;

  for (const prefix of DENY_PREFIXES) {
    if (slug.startsWith(prefix)) return true;
  }

  const firstSegment = slug.split('/')[0];
  if (FIRST_SEGMENT_EXCLUSIONS.has(firstSegment)) return true;

  if (ROOT_DATE_SLUG.test(slug)) return true;

  if (slug.startsWith('_brain-')) return true;

  if (isAgentWorkspaceConvention(slug)) return true;

  if (overrides) {
    if (overrides.excludeSlugs?.includes(slug)) return true;
    for (const prefix of overrides.excludePrefixes ?? []) {
      if (slug.startsWith(prefix)) return true;
    }
  }

  return false;
}
