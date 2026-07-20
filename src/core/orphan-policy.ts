/**
 * Shared orphan-reporting exclusion policy.
 *
 * These are pages where "no inbound links" is expected and should not count
 * against health. Keep this in core so the CLI orphan report and engine health
 * dashboard cannot drift.
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
  'josa-secrets/',
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

export function shouldExcludeFromOrphanReporting(slug: string): boolean {
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
  if (slug.endsWith('-ga4-property-id.md')) return true;
  if (slug.endsWith('-josa-test')) return true;
  if (slug === 'welcome' || slug === 'untitled') return true;

  if (isAgentWorkspaceConvention(slug)) return true;

  return false;
}
