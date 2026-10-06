/**
 * Always-loaded core memory tier.
 *
 * The owner designates a few pages as core with frontmatter
 * `always_load: true` (optional `core_priority`, lower renders first). Core
 * pages are rendered into every session's prompt through the lanes gbrain
 * already reaches (session-start hooks, the OpenClaw assemble block,
 * compiled instruction files, and the `context_pack` verb), under one
 * brain-wide character budget that the write path enforces
 * (src/core/persistence/core-guard.ts).
 *
 * Everything here is deterministic and zero-LLM. The rendered unit is the
 * page title plus its compiled truth (never the timeline), in the same
 * remote-safe view `get_page` gives an untrusted caller, so budget
 * accounting and delivery always agree.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { sanitizeRemoteBody } from './remote-body.ts';
import { privatePagesFilterFragment } from './search/private-visibility.ts';

export const CORE_DEFAULT_MAX_CHARS = 4000;
export const CORE_MIN_MAX_CHARS = 500;
export const CORE_MAX_MAX_CHARS = 6000;
export const CORE_MAX_PAGES = 50;
export const CORE_DEFAULT_PRIORITY = 100;
/** Bumped whenever the rendered shape of a core page changes. */
export const CORE_RENDER_VERSION = 1;
export const CORE_DOCS = 'docs/guides/core-memory.md';

export const CORE_CONFIG_KEYS = {
  enabled: 'memory.core.enabled',
  maxChars: 'memory.core.max_chars',
  remoteEdit: 'memory.core.remote_edit',
} as const;

export type CoreRemoteEditMode = 'allow' | 'notify' | 'refuse';

/** `always_load: true` is the on-disk spelling of "core"; every other value is not core. */
export function isCoreFrontmatter(frontmatter: unknown): boolean {
  return !!frontmatter && typeof frontmatter === 'object' && (frontmatter as Record<string, unknown>).always_load === true;
}

/** `core_priority` when it is a positive integer, else the default. */
export function corePriority(frontmatter: unknown): number {
  const raw = frontmatter && typeof frontmatter === 'object' ? (frontmatter as Record<string, unknown>).core_priority : undefined;
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : CORE_DEFAULT_PRIORITY;
}

/** The two owner-only keys, normalized, for change detection. */
export function coreMarking(frontmatter: unknown): { core: boolean; priority: number | null } {
  const fm = frontmatter && typeof frontmatter === 'object' ? frontmatter as Record<string, unknown> : {};
  return { core: isCoreFrontmatter(fm), priority: fm.core_priority === undefined ? null : corePriority(fm) };
}

export function parseCoreMaxChars(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= CORE_MIN_MAX_CHARS && n <= CORE_MAX_MAX_CHARS ? n : null;
}

export function parseCoreRemoteEdit(raw: string | null | undefined): CoreRemoteEditMode | null {
  const v = raw?.trim().toLowerCase();
  return v === 'allow' || v === 'notify' || v === 'refuse' ? v : null;
}

function parseBool(raw: string | null | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
  return null;
}

/** Validation for `gbrain config set` on the core keys; null when valid. */
export function validateCoreConfigValue(key: string, value: string): string | null {
  if (key === CORE_CONFIG_KEYS.maxChars && parseCoreMaxChars(value) === null) {
    return `${key} must be an integer from ${CORE_MIN_MAX_CHARS} to ${CORE_MAX_MAX_CHARS} (default ${CORE_DEFAULT_MAX_CHARS}).`;
  }
  if (key === CORE_CONFIG_KEYS.remoteEdit && parseCoreRemoteEdit(value) === null) return `${key} must be allow, notify or refuse (default notify).`;
  if (key === CORE_CONFIG_KEYS.enabled && parseBool(value) === null) return `${key} must be true or false (default false).`;
  return null;
}

export interface CoreSettings { enabled: boolean; maxChars: number; remoteEdit: CoreRemoteEditMode }

/** DB-plane settings; an out-of-range stored value falls back to the default (doctor names it). */
export async function readCoreSettings(engine: Pick<BrainEngine, 'getConfig'>): Promise<CoreSettings> {
  const [enabled, max, remote] = await Promise.all([
    engine.getConfig(CORE_CONFIG_KEYS.enabled).catch(() => null),
    engine.getConfig(CORE_CONFIG_KEYS.maxChars).catch(() => null),
    engine.getConfig(CORE_CONFIG_KEYS.remoteEdit).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabled) ?? false,
    maxChars: parseCoreMaxChars(max) ?? CORE_DEFAULT_MAX_CHARS,
    remoteEdit: parseCoreRemoteEdit(remote) ?? 'notify',
  };
}

export interface CorePageInput {
  source_id: string;
  slug: string;
  title: string;
  compiled_truth: string;
  frontmatter?: unknown;
  revision?: string | null;
}

export interface CorePage extends CorePageInput { priority: number; rendered: string; chars: number }

/** The rendered unit: title header plus the remote-safe compiled truth. */
export function renderCorePage(page: CorePageInput): string {
  const body = sanitizeRemoteBody(page.compiled_truth ?? '').trim();
  const title = (page.title || page.slug).replace(/\s+/g, ' ').trim();
  return `### ${title} (${page.source_id}:${page.slug})${body ? `\n${body}` : ''}`;
}

export function toCorePage(page: CorePageInput): CorePage {
  const rendered = renderCorePage(page);
  return { ...page, priority: corePriority(page.frontmatter), rendered, chars: rendered.length };
}

/** Total budgeted characters: rendered pages joined by blank lines. */
export function coreChars(pages: readonly Pick<CorePage, 'chars'>[]): number {
  return pages.reduce((sum, p, i) => sum + p.chars + (i > 0 ? 2 : 0), 0);
}

/** Session order: `default` first, then other sources; within a source by priority then slug. */
export function orderCorePages<T extends Pick<CorePage, 'source_id' | 'slug' | 'priority'>>(pages: readonly T[]): T[] {
  return [...pages].sort((a, b) => (a.source_id === 'default' ? 0 : 1) - (b.source_id === 'default' ? 0 : 1)
    || a.source_id.localeCompare(b.source_id) || a.priority - b.priority || a.slug.localeCompare(b.slug));
}

export interface CoreBlock {
  text: string;
  chars_used: number;
  chars_limit: number;
  pages: Array<{ source_id: string; slug: string; title: string; chars: number }>;
  truncated: boolean;
  omitted: Array<{ source_id: string; slug: string; reason: 'budget' | 'page_limit' | 'withheld' }>;
  revision: string;
}

export const CORE_BLOCK_FOOTER = 'Owner-designated pages, loaded in every session. Edit with edit_page (exact text, expected_revision) and keep them lean: detail belongs in linked pages. Only the owner adds or removes core pages (gbrain core add|remove).';

/** sha256 over the rendered pages and the limit, so any visible change moves it. */
export function coreRevision(pages: readonly Pick<CorePage, 'source_id' | 'slug' | 'rendered' | 'priority'>[], maxChars: number): string {
  const h = createHash('sha256');
  h.update(`v${CORE_RENDER_VERSION}|${maxChars}`);
  for (const p of orderCorePages(pages)) h.update(`\n${p.source_id}\u0000${p.slug}\u0000${p.priority}\u0000${p.rendered}`);
  return h.digest('hex').slice(0, 16);
}

export interface RenderCoreBlockOpts {
  maxChars: number;
  /** Extra lines shown under the header (remote-edit notices); not budgeted, capped at 5 + a count. */
  notices?: string[];
  /** Pages withheld by the delivery lane's sensitivity policy (slug + family; never text). */
  withheld?: Array<{ source_id: string; slug: string; family: string }>;
}

const MAX_NOTICE_LINES = 5;

/**
 * Render the injected block. Pages past the budget or the page cap are cut
 * whole, lowest priority first, with a visible truncation line; a page is
 * never sliced mid-text. Empty input renders as the empty string.
 */
export function renderCoreBlock(input: readonly CorePage[], opts: RenderCoreBlockOpts): CoreBlock {
  const ordered = orderCorePages(input);
  const kept: CorePage[] = [];
  const omitted: CoreBlock['omitted'] = [];
  let used = 0;
  for (const page of ordered) {
    if (kept.length >= CORE_MAX_PAGES) { omitted.push({ source_id: page.source_id, slug: page.slug, reason: 'page_limit' }); continue; }
    const next = used + page.chars + (kept.length ? 2 : 0);
    if (next > opts.maxChars) { omitted.push({ source_id: page.source_id, slug: page.slug, reason: 'budget' }); continue; }
    kept.push(page);
    used = next;
  }
  for (const w of opts.withheld ?? []) omitted.push({ source_id: w.source_id, slug: w.slug, reason: 'withheld' });
  const revision = coreRevision(ordered, opts.maxChars);
  if (kept.length === 0 && omitted.length === 0) {
    return { text: '', chars_used: 0, chars_limit: opts.maxChars, pages: [], truncated: false, omitted, revision };
  }
  const lines: string[] = [`## Core memory (always loaded) — ${used.toLocaleString('en-US')}/${opts.maxChars.toLocaleString('en-US')} chars`];
  const notices = opts.notices ?? [];
  for (const n of notices.slice(0, MAX_NOTICE_LINES)) lines.push(`> ${n}`);
  if (notices.length > MAX_NOTICE_LINES) lines.push(`> +${notices.length - MAX_NOTICE_LINES} more remote edits; review with gbrain core diff`);
  for (const w of opts.withheld ?? []) lines.push(`[core page ${w.source_id}:${w.slug} withheld: ${w.family}; run gbrain core status]`);
  const overBudget = omitted.filter(o => o.reason !== 'withheld');
  if (overBudget.length) {
    lines.push(`[core truncated: ${overBudget.length} page(s) over the ${opts.maxChars}-char budget or page cap left out; run gbrain core status]`);
  }
  const body = kept.map(p => p.rendered).join('\n\n');
  const text = `${lines.join('\n')}\n\n${body}${body ? '\n\n' : ''}${CORE_BLOCK_FOOTER}`;
  return {
    text, chars_used: used, chars_limit: opts.maxChars,
    pages: kept.map(p => ({ source_id: p.source_id, slug: p.slug, title: p.title, chars: p.chars })),
    truncated: overBudget.length > 0, omitted, revision,
  };
}

type RawExec = Pick<BrainEngine, 'executeRaw' | 'readPageSnapshot'>;

export interface ListCorePagesOpts {
  /** Restrict to these sources; omitted = every source in the brain. */
  sourceIds?: readonly string[];
  excludePrivate?: boolean;
  /** Exclude one page (the page being written, measured separately). */
  exclude?: { sourceId: string; slug: string };
}

interface CoreRow { source_id: string; slug: string; title: string | null; compiled_truth: string | null; frontmatter: unknown; withdrawn: boolean }

/**
 * Live core pages. Bounded: the cap leaves headroom over CORE_MAX_PAGES so
 * the renderer can still report what it left out.
 */
export async function listCorePages(exec: RawExec, opts: ListCorePagesOpts = {}): Promise<CorePage[]> {
  const params: unknown[] = [];
  const where = [`p.deleted_at IS NULL`, `p.frontmatter @> '{"always_load": true}'::jsonb`];
  if (opts.sourceIds) {
    params.push([...opts.sourceIds]);
    where.push(`p.source_id = ANY($${params.length}::text[])`);
  }
  if (opts.exclude) {
    params.push(opts.exclude.sourceId, opts.exclude.slug);
    where.push(`NOT (p.source_id = $${params.length - 1} AND p.slug = $${params.length})`);
  }
  if (opts.excludePrivate) where.push(privatePagesFilterFragment('p'));
  const rows = await exec.executeRaw<CoreRow>(
    `SELECT p.source_id, p.slug, p.title, p.compiled_truth, p.frontmatter,
        EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = p.source_id AND (w.subject = '*' OR w.subject = p.slug)) AS withdrawn
      FROM pages p WHERE ${where.join(' AND ')} ORDER BY p.source_id, p.slug LIMIT ${CORE_MAX_PAGES * 4}`, params);
  const pages: CorePage[] = [];
  for (const r of rows) {
    let compiled = r.compiled_truth ?? '';
    // Withdrawn facts (forget) are applied by the canonical snapshot read,
    // not by the stored body, so core never shows text get_page withholds.
    if (r.withdrawn) {
      const snap = await exec.readPageSnapshot(r.slug, { sourceId: r.source_id, ...(opts.excludePrivate ? { excludePrivate: true } : {}) });
      if (!snap) continue;
      compiled = snap.page.compiled_truth ?? '';
    }
    pages.push(toCorePage({
      source_id: r.source_id, slug: r.slug, title: r.title ?? r.slug, compiled_truth: compiled,
      frontmatter: typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter,
    }));
  }
  return pages;
}

/** The sources a session sees: `default` plus the session source. */
export function sessionCoreSources(sessionSourceId: string | null | undefined, allowed?: readonly string[] | null): string[] {
  const wanted = [...new Set(['default', sessionSourceId || 'default'])];
  return allowed ? wanted.filter(s => allowed.includes(s)) : wanted;
}

export interface LoadCoreBlockOpts {
  sessionSourceId?: string | null;
  /** Federated grant; when set, only these sources render. */
  allowedSources?: readonly string[] | null;
  excludePrivate?: boolean;
  notices?: string[];
  settings?: CoreSettings;
}

/** Credential-like PII withholds the page; contact details and private paths are redacted in place. */
const REDACT_IN_PLACE = new Set(['pii:email', 'pii:phone', 'path']);

/**
 * Delivery sensitivity policy (sensitivity-scan.ts, the compile-context
 * detector): a page with a secret, blocklist, operator-pattern or
 * credential-shaped PII hit is withheld with a visible line naming the
 * family; email, phone and private-path hits are redacted in place.
 */
export async function applyCoreSensitivity(pages: readonly CorePage[]): Promise<{ pages: CorePage[]; withheld: Array<{ source_id: string; slug: string; family: string }> }> {
  const { loadSensitivityConfig, scanSensitive, PATH_SHAPE_RES } = await import('./context/sensitivity-scan.ts');
  const { findPii } = await import('./eval-capture-scrub.ts');
  let config: ReturnType<typeof loadSensitivityConfig>;
  // A broken operator pattern file must not switch the secret scan off: fall back to the built-in detectors.
  try { config = loadSensitivityConfig({}); } catch { config = { allowlist: [], blocklistRe: null, patterns: [] } as unknown as ReturnType<typeof loadSensitivityConfig>; }
  const out: CorePage[] = [];
  const withheld: Array<{ source_id: string; slug: string; family: string }> = [];
  for (const page of pages) {
    const findings = scanSensitive(page.rendered, config);
    // The operator pattern file also matches contact details; the same value found as email/phone is redacted, not withheld.
    const redactable = new Set(findings.filter(f => REDACT_IN_PLACE.has(f.family)).map(f => f.fingerprint));
    const blocking = findings.find(f => !REDACT_IN_PLACE.has(f.family) && !redactable.has(f.fingerprint));
    if (blocking) { withheld.push({ source_id: page.source_id, slug: page.slug, family: blocking.family }); continue; }
    if (!findings.length) { out.push(page); continue; }
    let text = page.compiled_truth;
    for (const f of findPii(text).filter(x => x.family === 'email' || x.family === 'phone').sort((a, b) => b.start - a.start)) {
      text = `${text.slice(0, f.start)}[redacted ${f.family}]${text.slice(f.end)}`;
    }
    for (const re of PATH_SHAPE_RES) text = text.replace(new RegExp(re.source, 'g'), '[redacted path]/');
    out.push({ ...toCorePage({ ...page, compiled_truth: text }), priority: page.priority });
  }
  return { pages: out, withheld };
}

/** Pending remote-edit notices for the given sources, newest first (notify policy). */
export async function pendingCoreNotices(exec: Pick<BrainEngine, 'executeRaw'>, sourceIds?: readonly string[]): Promise<Array<{ source_id: string; slug: string; revision: string | null; actor: string; created_at: string }>> {
  try {
    return await exec.executeRaw(
      `SELECT DISTINCT ON (source_id, slug) source_id, slug, revision, actor, created_at::text AS created_at
         FROM core_edit_notices WHERE acked_at IS NULL ${sourceIds ? 'AND source_id = ANY($1::text[])' : ''}
        ORDER BY source_id, slug, id DESC LIMIT 50`, sourceIds ? [[...sourceIds]] : []);
  } catch {
    return [];
  }
}

export function coreNoticeLine(n: { source_id: string; slug: string; revision: string | null; actor: string }): string {
  return `Core page ${n.source_id}:${n.slug} was edited remotely by ${n.actor}. The user should review it: gbrain core diff --source ${n.source_id} ${n.slug}, then gbrain core ack --source ${n.source_id} ${n.slug} --revision ${n.revision ?? 'latest'}.`;
}

/** The block a session receives; empty text when core is disabled or empty. */
export async function loadCoreBlock(engine: Pick<BrainEngine, 'executeRaw' | 'readPageSnapshot' | 'getConfig'>, opts: LoadCoreBlockOpts = {}): Promise<CoreBlock & { enabled: boolean }> {
  const settings = opts.settings ?? await readCoreSettings(engine);
  if (!settings.enabled) {
    return { text: '', chars_used: 0, chars_limit: settings.maxChars, pages: [], truncated: false, omitted: [], revision: 'disabled', enabled: false };
  }
  const sourceIds = sessionCoreSources(opts.sessionSourceId, opts.allowedSources ?? null);
  const listed = await listCorePages(engine, { sourceIds, excludePrivate: opts.excludePrivate ?? true });
  const { pages, withheld } = await applyCoreSensitivity(listed);
  const notices = opts.notices ?? (listed.length ? (await pendingCoreNotices(engine, sourceIds)).map(coreNoticeLine) : []);
  return { ...renderCoreBlock(pages, { maxChars: settings.maxChars, notices, withheld }), enabled: true };
}

/** Brain-wide accounting used by the write-path guard and `gbrain core status`. */
export async function coreUsage(exec: RawExec, opts: { exclude?: { sourceId: string; slug: string } } = {}): Promise<{ pages: CorePage[]; chars: number }> {
  const pages = orderCorePages(await listCorePages(exec, { exclude: opts.exclude }));
  return { pages, chars: coreChars(pages) };
}
