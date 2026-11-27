/**
 * Reads and writes of idea and initiative pages. Writes go through the page
 * mutation coordinator (put_page), so they are attributed, revision-checked
 * and work on managed brains; background work (jobs, the ideas phase) writes
 * with a trusted local context.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { serializeMarkdown } from '../markdown.ts';
import type { PageType } from '../types.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import { IDEA_TYPE, INITIATIVE_TYPE, SLACK_CHANNEL_ID, initiativeStatusOf, stringList, type InitiativesConfig } from './model.ts';

export interface StoredPage {
  sourceId: string;
  slug: string;
  type: string | null;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  timeline: string;
  tags: string[];
  revision: string;
}

/** A trusted, local operation context for background writes (jobs, cycle phases). */
export function localContext(engine: BrainEngine, sourceId: string): OperationContext {
  return {
    engine, config: { engine: engine.kind } as never, remote: false, sourceId, dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
  } as OperationContext;
}

/** A deterministic UUID-shaped request id: retries of the same write replay instead of writing twice. */
export function requestIdFor(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
    .replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*/, '$1-$2-4$3-a$4-$5');
}

export async function readPage(engine: BrainEngine, sourceId: string, slug: string): Promise<StoredPage | null> {
  const snap = await engine.readPageSnapshot(slug, { sourceId });
  if (!snap) return null;
  const p = snap.page;
  // Lifecycle pages are rewritten whole (frontmatter + body); a segmented page is refused, not truncated.
  assertInlineBody(p, 'initiatives.readPage');
  return {
    sourceId, slug: p.slug, type: p.type ?? null, title: p.title ?? '', frontmatter: { ...(p.frontmatter ?? {}) },
    body: p.compiled_truth ?? '', timeline: p.timeline ?? '', tags: snap.tags ?? [], revision: snap.revision,
  };
}

export interface PageWrite {
  sourceId: string;
  slug: string;
  type: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  timeline?: string;
  tags?: string[];
  /** Revision read; omit to create. */
  expectedRevision?: string;
  /** Stable parts of the request id (defaults to slug + content hash). */
  requestKey?: string[];
}

/** Writes a whole page through put_page as `ctx` (the caller's identity, scopes and attribution apply). */
export async function writePage(ctx: OperationContext, w: PageWrite): Promise<Record<string, unknown>> {
  const fm = { ...w.frontmatter };
  delete fm.type; delete fm.title; delete fm.tags; delete fm.slug;
  const content = serializeMarkdown(fm, w.body, w.timeline ?? '', { type: w.type as PageType, title: w.title, tags: w.tags ?? [] });
  const key = w.requestKey ?? [w.sourceId, w.slug, w.expectedRevision ?? 'create', content];
  return submitPageMutation({ ...ctx, sourceId: w.sourceId }, {
    operation: 'put_page',
    params: {
      slug: w.slug, content, source_id: w.sourceId,
      ...(w.expectedRevision ? { expected_revision: w.expectedRevision } : {}),
      request_id: requestIdFor('initiatives', ...key),
    },
  });
}

/**
 * Read-modify-write of one page. `mutate` returns the new frontmatter/body (or null for no change).
 * A concurrent edit (revision conflict) is retried once on the fresh revision.
 */
export async function updatePage(ctx: OperationContext, sourceId: string, slug: string,
  mutate: (page: StoredPage) => { frontmatter?: Record<string, unknown>; body?: string; title?: string } | null): Promise<StoredPage | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await readPage(ctx.engine, sourceId, slug);
    if (!page) return null;
    const change = mutate(page);
    if (!change) return page;
    const next: StoredPage = { ...page, frontmatter: change.frontmatter ?? page.frontmatter, body: change.body ?? page.body, title: change.title ?? page.title };
    try {
      await writePage(ctx, {
        sourceId, slug, type: page.type ?? 'note', title: next.title, frontmatter: next.frontmatter, body: next.body,
        timeline: page.timeline, tags: page.tags, expectedRevision: page.revision,
      });
      return next;
    } catch (err) {
      const code = (err as { code?: string })?.code ?? '';
      if (attempt === 0 && /revision|conflict|changed/i.test(`${code} ${(err as Error)?.message ?? ''}`)) continue;
      throw err;
    }
  }
  return null;
}

interface PageRow { slug: string; title: string | null; type: string | null; frontmatter: Record<string, unknown> | null; updated_at: string | Date }

async function pagesOfType(engine: BrainEngine, sourceId: string, type: string): Promise<PageRow[]> {
  return engine.executeRaw<PageRow>(
    `SELECT p.slug, p.title, p.type, p.frontmatter, p.updated_at FROM pages p
      WHERE p.source_id = $1 AND p.type = $2 AND p.deleted_at IS NULL ORDER BY p.slug`,
    [sourceId, type],
  );
}

export interface InitiativeRow { sourceId: string; slug: string; title: string; frontmatter: Record<string, unknown> }

export async function listInitiatives(engine: BrainEngine, cfg: InitiativesConfig): Promise<InitiativeRow[]> {
  return (await pagesOfType(engine, cfg.sourceId, INITIATIVE_TYPE))
    .map(r => ({ sourceId: cfg.sourceId, slug: r.slug, title: r.title ?? r.slug, frontmatter: r.frontmatter ?? {} }));
}

export async function listIdeas(engine: BrainEngine, cfg: InitiativesConfig): Promise<InitiativeRow[]> {
  return (await pagesOfType(engine, cfg.sourceId, IDEA_TYPE))
    .map(r => ({ sourceId: cfg.sourceId, slug: r.slug, title: r.title ?? r.slug, frontmatter: r.frontmatter ?? {} }));
}

export function slackChannelsOf(frontmatter: Record<string, unknown>): string[] {
  return stringList(frontmatter.slack_channels).map(c => c.toUpperCase()).filter(c => SLACK_CHANNEL_ID.test(c));
}

/**
 * An initiative still reads its Slack channels while it is active, and after it
 * finishes until finish_initiative has released them (the final sync).
 */
export function readsSlack(frontmatter: Record<string, unknown>): boolean {
  return initiativeStatusOf(frontmatter) === 'active' || !frontmatter.slack_released_at;
}

/** Channel id → the initiative that reads it (active, or finished and not yet released). */
export async function initiativeChannels(engine: BrainEngine, cfg: InitiativesConfig): Promise<Array<{ channel: string; initiative: InitiativeRow }>> {
  const out: Array<{ channel: string; initiative: InitiativeRow }> = [];
  for (const row of await listInitiatives(engine, cfg)) {
    if (!readsSlack(row.frontmatter)) continue;
    for (const channel of slackChannelsOf(row.frontmatter)) {
      if (!out.some(o => o.channel === channel)) out.push({ channel, initiative: row });
    }
  }
  return out;
}

export async function initiativeForChannel(engine: BrainEngine, cfg: InitiativesConfig, channel: string): Promise<InitiativeRow | null> {
  const id = channel.toUpperCase();
  return (await initiativeChannels(engine, cfg)).find(c => c.channel === id)?.initiative ?? null;
}

/** Resolve a page reference (slug or bare name) under a prefix: `x` → `<prefix>x` when that page exists. */
export async function resolveUnderPrefix(engine: BrainEngine, sourceId: string, prefix: string, ref: string): Promise<string | null> {
  const clean = ref.trim().replace(/^\[\[(.*?)(\|.*)?\]\]$/, '$1').replace(/\.md$/, '');
  for (const slug of [clean, clean.startsWith(prefix) ? null : `${prefix}${clean}`]) {
    if (!slug) continue;
    const [row] = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`, [sourceId, slug]);
    if (row) return row.slug;
  }
  return null;
}
