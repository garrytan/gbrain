/**
 * GST-2462: privacy labels gbrain does not read. A page with no `visibility` is private by an alias only when
 * `access` or `confidentiality` holds one of the values in PRIVACY_ALIASES. Any other value is ignored: the page
 * reads like an unlabelled page to remote callers, and git placement (declaredDatabaseOnly) does not keep it out of
 * the brain's git remote. Writers stamp these keys with their own words (`access: personal`), so this module
 * finds such pages and says so. It changes no read: the alias lists and `visibility.honor_aliases` stay as they are.
 *
 * A page is reported when it has no `visibility`, no recognized alias value on either key, no other rule that makes
 * it private by default (pinned questions, atoms, synthesized concepts, life-chronicle events, pages whose privacy
 * follows a declared origin), and a non-empty value on `access` or `confidentiality`. ignoredPrivacyLabels and
 * ignoredPrivacyLabelSql are the TypeScript and SQL forms of that rule.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action, Notice } from '../agent-output.ts';
import type { OperationContext } from '../ops/contract.ts';
import { parseMarkdown } from '../markdown.ts';
import { edgeTrimSql } from '../edge-whitespace.ts';
import { isPrivacyDerivationPrivate, PRIVACY_ALIASES, privacyAliasSql } from './private-visibility.ts';

export const PRIVACY_LABEL_IGNORED = 'privacy_label_ignored';
export const PRIVACY_LABEL_KEYS: readonly string[] = Object.keys(PRIVACY_ALIASES);
/** A value whose plain meaning is private: the doctor check warns on these and reports the rest as information. */
export const PLAINLY_PRIVATE_RE = /private|confidential|secret|restricted|personal|health|therapy/i;
const DISPLAY_CHARS = 80;
const NOTICE_VALUES = 5;
/** Pages a bulk run's notice or the doctor check reads at most. */
export const SCAN_CAP = 100_000;
/** A notice read on a write or sync path ends on the server after this long, and a read it ends gives no notice. */
export const NOTICE_READ_TIMEOUT_MS = 1_000;
const LABEL_LINE_RE = new RegExp(`^\\s*["']?(?:${PRIVACY_LABEL_KEYS.join('|')})["']?\\s*:`, 'im');

export interface IgnoredPrivacyLabel { key: string; value: string }
export interface IgnoredLabelCount extends IgnoredPrivacyLabel { pages: number }

function labelText(value: unknown): string | null {
  if (value == null) return null;
  const text = typeof value === 'string' ? value.trim() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text === '' ? null : text;
}

/** The `access` / `confidentiality` values gbrain ignores on this page; empty when none is ignored. */
export function ignoredPrivacyLabels(page: { type?: string | null; frontmatter?: unknown }): IgnoredPrivacyLabel[] {
  const fm = typeof page.frontmatter === 'object' && page.frontmatter !== null && !Array.isArray(page.frontmatter)
    ? page.frontmatter as Record<string, unknown> : null;
  if (!fm || fm.visibility != null || isPrivacyDerivationPrivate(page)) return [];
  if (fm.derived_from != null || fm.source_slug != null) return [];
  if (page.type === 'event' && typeof fm.captured_via === 'string' && fm.captured_via.startsWith('life-chronicle:')) return [];
  return PRIVACY_LABEL_KEYS.flatMap(key => {
    const value = labelText(fm[key]);
    return value === null ? [] : [{ key, value }];
  });
}

/** SQL twin of ignoredPrivacyLabels (non-empty) on a page alias, a code-provided literal. */
export function ignoredPrivacyLabelSql(p: string): string {
  const fm = (key: string) => `${p}.frontmatter->>'${key}'`;
  return `(${fm('visibility')} IS NULL AND NOT ${privacyAliasSql(p)}
    AND ${fm('pinned_question')} IS NULL AND COALESCE(${p}.type, '') NOT IN ('atom', 'question')
    AND NOT (${p}.type = 'concept' AND ${fm('synthesized_by')} IS NOT NULL)
    AND NOT (${p}.type = 'event' AND ${fm('captured_via')} LIKE 'life-chronicle:%')
    AND ${fm('derived_from')} IS NULL AND ${fm('source_slug')} IS NULL
    AND (${PRIVACY_LABEL_KEYS.map(key => `NULLIF(${edgeTrimSql(fm(key))}, '') IS NOT NULL`).join(' OR ')}))`;
}

/** GIN-servable prefilter (idx_pages_frontmatter, jsonb_ops): the page carries one of the label keys at all. */
export function privacyLabelKeySql(p: string): string {
  return `(${PRIVACY_LABEL_KEYS.map(key => `${p}.frontmatter ? '${key}'`).join(' OR ')})`;
}

export function displayLabelValue(value: string): string {
  const shown = value.length > DISPLAY_CHARS ? `${value.slice(0, DISPLAY_CHARS)}…` : value;
  return JSON.stringify(shown);
}

function recognized(key: string): string {
  const values = [...(PRIVACY_ALIASES[key] ?? [])];
  const last = values.pop();
  return values.length ? `${values.join(', ')} or ${last}` : last ?? '';
}

/**
 * Does this source keep pages in a git checkout (its own path, canonical git, or the default source's sync.repo_path)?
 * A repo-less source answers false and its notice leaves out the git sentence. An unreadable answer counts as true.
 */
export async function sourceHasRepo(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<boolean> {
  try {
    const [row] = await engine.executeRaw<{ repo: boolean }>(
      `SELECT (COALESCE(s.local_path, '') <> '' OR s.config->>'canonical' = 'git'
          OR (s.id = 'default' AND EXISTS (SELECT 1 FROM config c WHERE c.key = 'sync.repo_path' AND COALESCE(c.value, '') <> ''))) AS repo
        FROM sources s WHERE s.id = $1`, [sourceId], { timeoutMs: NOTICE_READ_TIMEOUT_MS });
    return row ? row.repo === true : false;
  } catch {
    return true;
  }
}

/**
 * The one notice for a write that stored ignored labels: a single page (`slug`) or a bulk run (counts by value, never
 * slugs). It names each key and value, says what remote callers see and (with a repo) that git does not hold the page
 * back, and asks to add `visibility: private`. It quotes no page content.
 */
export function ignoredPrivacyLabelNotice(input: { labels: IgnoredLabelCount[]; pages: number; repo: boolean; sourceId: string; slug?: string; run?: 'import' | 'sync' }): Notice {
  const sorted = [...input.labels].sort((a, b) => b.pages - a.pages || a.key.localeCompare(b.key) || a.value.localeCompare(b.value));
  const shown = sorted.slice(0, NOTICE_VALUES).map(l => `${l.key}: ${displayLabelValue(l.value)}${input.slug ? '' : ` (${l.pages} page${l.pages === 1 ? '' : 's'})`}`);
  const more = sorted.length > NOTICE_VALUES ? `, and ${sorted.length - NOTICE_VALUES} more value(s)` : '';
  const keys = [...new Set(sorted.map(l => l.key))];
  const known = keys.map(key => `${key} as private only when it is ${recognized(key)}`).join(', and ');
  const subject = input.slug
    ? `Page ${input.slug} has ${shown.join(' and ')} and no visibility key`
    : `${input.pages}${input.pages >= SCAN_CAP ? '+' : ''} page(s) written to source ${input.sourceId} during this ${input.run ?? 'run'} carry a privacy label gbrain does not recognize and no visibility key: ${shown.join(', ')}${more}`;
  const them = input.slug ? 'it' : 'them';
  const why = `${subject}. gbrain reads ${known}; it ignores any other value, so the label does not make ${input.slug ? 'the page' : 'these pages'} private: `
    + `every remote caller that can read the source can read ${them} (unless readable_by or a folder rule limits ${them})`
    + (input.repo ? `, and the label does not keep ${them} out of git, so ${them} can be committed and pushed to the brain's git remote` : '')
    + `. To keep ${input.slug ? 'the page' : 'a page'} private, add visibility: private to its frontmatter.`;
  const user_message = input.slug
    ? `The page ${input.slug} is labelled ${shown.join(' and ')}, but gbrain doesn't treat that label as private, so it is readable over MCP${input.repo ? ' and can be pushed to git' : ''}. Should I add visibility: private to it?`
    : `${input.pages} page(s) are labelled with a privacy value gbrain doesn't recognize (${shown.join(', ')}${more}), so they are readable over MCP${input.repo ? ' and can be pushed to git' : ''}. Should I add visibility: private to the ones that should stay private?`;
  const fix: Action = {
    ask_user: true, consent: [], actor: 'agent', requires_exclusive: false, user_message,
    why: 'Adding visibility: private makes the page private to remote callers and keeps it out of git; it narrows who can read the page, so ask first.',
    verify: input.slug
      ? { argv: ['gbrain', 'get', input.slug, '--source', input.sourceId], mcp: { tool: 'get_page', arguments: { slug: input.slug, source_id: input.sourceId } } }
      : { argv: ['gbrain', 'doctor', '--only', PRIVACY_LABEL_IGNORED, '--json'] },
    docs: 'docs/guides/access-designations.md#unrecognized-label-values',
  };
  return { code: PRIVACY_LABEL_IGNORED, kind: 'safety', why, user_message, fix };
}

/** Tally ignored labels over pages (each page counted once per key and value). */
export function tallyIgnoredLabels(pages: Iterable<IgnoredPrivacyLabel[]>): { labels: IgnoredLabelCount[]; pages: number } {
  const counts = new Map<string, IgnoredLabelCount>();
  let total = 0;
  for (const labels of pages) {
    if (!labels.length) continue;
    total++;
    for (const l of labels) {
      const id = `${l.key}\u0000${l.value}`;
      const hit = counts.get(id);
      if (hit) hit.pages++;
      else counts.set(id, { ...l, pages: 1 });
    }
  }
  return { labels: [...counts.values()], pages: total };
}

/**
 * A bulk run's one notice over the pages it stored in `sourceId`: by slug (`slugs`, the run's own list) or, when the run
 * keeps no list (a managed sync), the source's pages updated since the run started (`since`, a database timestamp).
 * Only pages that carry a label key are read (the GIN prefilter), at most SCAN_CAP of them; null when there are none or
 * the read fails, so the notice never fails a run.
 */
export async function ignoredPrivacyLabelRunNotice(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string,
  scope: { slugs: readonly string[] } | { since: string }, run: 'import' | 'sync'): Promise<Notice | null> {
  if ('slugs' in scope && !scope.slugs.length) return null;
  try {
    const rows = await engine.executeRaw<{ type: string | null; frontmatter: Record<string, unknown> | null }>(
      `SELECT p.type, p.frontmatter FROM pages p
        WHERE p.source_id = $1 AND ${'slugs' in scope ? 'p.slug = ANY($2::text[])' : 'p.updated_at >= $2::timestamptz'} AND p.deleted_at IS NULL
          AND NOT (p.frontmatter ? 'readable_by') AND p.folder_rule_ids IS NULL
          AND ${privacyLabelKeySql('p')} AND ${ignoredPrivacyLabelSql('p')}
        LIMIT ${SCAN_CAP}`, [sourceId, 'slugs' in scope ? [...new Set(scope.slugs)] : scope.since], { timeoutMs: NOTICE_READ_TIMEOUT_MS });
    const tally = tallyIgnoredLabels(rows.map(row => ignoredPrivacyLabels(row)));
    if (!tally.pages) return null;
    return ignoredPrivacyLabelNotice({ ...tally, repo: await sourceHasRepo(engine, sourceId), sourceId, run });
  } catch {
    return null;
  }
}

/**
 * put_page: one notice when the page it stored carries ignored labels, then the write's own result. Reads the committed
 * page back (the stored frontmatter decides, not the request), or parses the request while the write is still pending.
 * Skips content with no label line, and never throws.
 */
export async function withIgnoredPrivacyLabelNotice<R>(ctx: Pick<OperationContext, 'engine' | 'emitNotice'>, sourceId: string,
  params: Record<string, unknown>, result: R): Promise<R> {
  const content = params.content;
  if (!ctx.emitNotice || typeof content !== 'string' || !LABEL_LINE_RE.test(content)) return result;
  try {
    const written = (result ?? {}) as Record<string, unknown>;
    const stored = typeof written.slug === 'string' ? written.slug : String(params.slug);
    const committed = written.status === 'created_or_updated' || written.status === 'skipped';
    const [page] = committed ? await ctx.engine.executeRaw<{ type: string | null; frontmatter: Record<string, unknown> | null }>(
      'SELECT type, frontmatter FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, stored],
      { timeoutMs: NOTICE_READ_TIMEOUT_MS }) : [];
    const labels = ignoredPrivacyLabels(page ?? parseMarkdown(content, `${stored}.md`));
    if (labels.length) ctx.emitNotice(ignoredPrivacyLabelNotice({ labels: labels.map(l => ({ ...l, pages: 1 })), pages: 1,
      repo: await sourceHasRepo(ctx.engine, sourceId), sourceId, slug: stored }));
  } catch { /* the notice never fails a write */ }
  return result;
}
