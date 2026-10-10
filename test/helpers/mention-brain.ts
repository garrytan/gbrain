/**
 * Entity mention index test helpers: a PGLite brain on the init-default
 * schema pack (gbrain-base-v2) and small readers for mention links, derived
 * aliases and status rows.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { setCliOptions } from '../../src/core/cli-options.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import type { PageType } from '../../src/core/types.ts';

export async function mentionBrain(): Promise<PGLiteEngine> {
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
  return engine;
}

/** Empties every table the tests write (pages cascade to links, aliases and mention state). */
export async function resetMentionBrain(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM page_aliases');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw('DELETE FROM mention_gazetteer_entries');
  await engine.executeRaw('DELETE FROM mention_index_status');
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  for (const key of ['auto_link', 'mentions.auto_link', 'mentions.entity_types', 'mentions.ignore', 'link_resolution.cross_source', 'entity_identity.union',
    'mentions.exclude_slugs', 'mentions.alias_deny', 'mentions.multiword_aliases', 'mentions.sibling_merge', 'search.alias_fanout_max', 'search.demote_generated']) {
    await engine.unsetConfig(key);
  }
}

export async function page(engine: BrainEngine, slug: string, type: string, title: string, body: string,
  opts: { frontmatter?: Record<string, unknown>; sourceId?: string; timeline?: string } = {}): Promise<void> {
  await engine.putPage(slug, { type: type as PageType, title, compiled_truth: body, timeline: opts.timeline ?? '', frontmatter: opts.frontmatter ?? {} },
    opts.sourceId ? { sourceId: opts.sourceId } : undefined);
}

export async function sweep(engine: BrainEngine, opts: { sourceIdFilter?: string; timeBudgetMs?: number } = {}) {
  return extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: opts.timeBudgetMs === undefined, ...opts });
}

/** `from -> to` for every mention link, sorted; typed_ner rows carry their kind. */
export async function mentionLinks(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ f: string; t: string; kind: string | null }>(
    `SELECT f.slug AS f, t.slug AS t, l.link_kind AS kind FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_source = 'mentions' ORDER BY 1, 2, 3`);
  return rows.map(r => `${r.f} -> ${r.t}${r.kind === 'typed_ner' ? ' (typed_ner)' : ''}`);
}

export async function derivedAliases(engine: BrainEngine, slug: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ alias_norm: string; origin: string; case_sensitive: boolean }>(
    'SELECT alias_norm, origin, case_sensitive FROM page_aliases WHERE slug = $1 ORDER BY origin, alias_norm', [slug]);
  return rows.map(r => `${r.origin}:${r.alias_norm}${r.case_sensitive ? ' (cs)' : ''}`);
}

export const ctxFor = (engine: BrainEngine, remote: boolean, notices: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default',
  emitNotice: (n: unknown) => { notices.push(n); }, ...extra,
}) as never;
