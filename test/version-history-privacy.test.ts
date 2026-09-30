import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageVersion } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const databases: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];
const sourceId = 'version-history-privacy';
beforeAll(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  databases.push({ engine, close: () => engine.disconnect() });
  if (process.env.DATABASE_URL) databases.push(await isolatedPersistencePostgres(process.env.DATABASE_URL));
  for (const { engine } of databases) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
}, 120_000);
afterAll(async () => { for (const { close } of databases) await close(); });
function context(engine: BrainEngine, remote?: boolean): OperationContext {
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, sourceId, remote: remote ?? true, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } };
  // Exercise the runtime trust boundary when an older caller omits the flag.
  if (remote === undefined) Reflect.deleteProperty(ctx, 'remote');
  return ctx;
}
const history = (engine: BrainEngine, slug: string, remote?: boolean) =>
  operationsByName.get_versions.handler(context(engine, remote), { slug }) as Promise<PageVersion[]>;
function protectedBody(prefix: string): string {
  return `${prefix} public prose\n${renderFactsTable([
    { rowNum: 1, claim: `${prefix} world fact`, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    { rowNum: 2, claim: `${prefix} private fact`, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
  ])}\n${renderTakesFence([
    { rowNum: 1, claim: `${prefix} private take`, kind: 'take', holder: 'owner-example', weight: 1, active: true },
    { rowNum: 2, claim: `${prefix} world take`, kind: 'take', holder: 'world', weight: 1, active: true },
  ])}`;
}

test('complete versions filter timeline and body fences remotely while local history preserves every field', async () => {
  for (const { engine } of databases) {
    const slug = 'world-history'; const compiled_truth = protectedBody('Body'); const timeline = protectedBody('Timeline');
    await engine.putPage(slug, { type: 'note', title: 'Visible historical title', compiled_truth, timeline,
      frontmatter: { visibility: 'world', custom: 'visible metadata' } }, { sourceId });
    await engine.addTag(slug, 'visible-tag', { sourceId });
    await engine.createVersion(slug, { sourceId });
    const stored = await engine.getVersions(slug, { sourceId });
    expect(await history(engine, slug, false)).toEqual(stored);
    for (const remote of [true, undefined]) {
      const versions = await history(engine, slug, remote); expect(versions).toHaveLength(1);
      const version = versions[0];
      for (const [field, prefix] of [['compiled_truth', 'Body'], ['timeline', 'Timeline']] as const) {
        expect(version[field]).toContain(`${prefix} public prose`); expect(version[field]).toContain(`${prefix} world fact`);
        expect(version[field]).not.toContain(`${prefix} private fact`); expect(version[field]).not.toContain(`${prefix} private take`);
        expect(version[field]).not.toContain(`${prefix} world take`); expect(version[field]).not.toContain('gbrain:takes');
      }
      for (const field of ['id', 'page_id', 'title', 'type', 'tags', 'frontmatter', 'knowledge_revision', 'is_deleted', 'snapshot_at'] as const) {
        expect(version[field]).toEqual(stored[0][field]);
      }
    }
    expect(stored[0].timeline).toContain('Timeline private fact'); expect(stored[0].timeline).toContain('Timeline private take');
  }
});

test('legacy NULL and absent timeline fields stay unchanged while their body still receives remote filtering', async () => {
  for (const { engine } of databases) {
    const slug = 'legacy-history';
    const page = await engine.putPage(slug, { type: 'note', title: 'Legacy', compiled_truth: 'Current prose' }, { sourceId });
    await engine.executeRaw('INSERT INTO page_versions(page_id,compiled_truth,frontmatter) VALUES($1,$2,$3::text::jsonb)',
      [page.id, protectedBody('Legacy'), '{}']);
    const [remote] = await history(engine, slug, true); expect(remote.timeline).toBeNull(); expect(remote.is_deleted).toBeNull();
    expect(remote.compiled_truth).toContain('Legacy world fact'); expect(remote.compiled_truth).not.toContain('Legacy private fact');
    const [local] = await history(engine, slug, false); expect(local.timeline).toBeNull(); expect(local.compiled_truth).toContain('Legacy private fact');
    // Older engine adapters may omit fields entirely. Keep that shape instead
    // of fabricating an empty timeline that a caller could mistake for data.
    const original = engine.getVersions;
    engine.getVersions = async function (this: BrainEngine, ...args: Parameters<BrainEngine['getVersions']>) {
      return (await original.apply(this, args)).map(({ timeline: _timeline, ...version }) => version);
    };
    try {
      const [absent] = await history(engine, slug, true);
      expect(absent.timeline).toBeUndefined(); expect(Object.hasOwn(absent, 'timeline')).toBe(false);
      expect(absent.compiled_truth).not.toContain('Legacy private fact');
    } finally { engine.getVersions = original; }
  }
});

test('new snapshot metadata stays behind both historical and current page privacy predicates', async () => {
  for (const { engine } of databases) {
    const slug = 'private-history';
    await engine.putPage(slug, { type: 'note', title: 'Private historical title', compiled_truth: 'Private body', timeline: 'Private timeline',
      frontmatter: { visibility: 'private', private_metadata: 'Private metadata' } }, { sourceId });
    await engine.addTag(slug, 'private-tag', { sourceId });
    const hidden = await engine.createVersion(slug, { sourceId });
    await engine.putPage(slug, { type: 'note', title: 'Public current title', compiled_truth: 'Public body', timeline: 'Public timeline',
      frontmatter: { visibility: 'world' } }, { sourceId });
    await engine.removeTag(slug, 'private-tag', { sourceId });
    const visible = await engine.createVersion(slug, { sourceId });
    expect((await history(engine, slug, true)).map(version => version.id)).toEqual([visible.id]);
    const local = await history(engine, slug, false);
    expect(local.map(version => version.id)).toContain(hidden.id);
    expect(local.find(version => version.id === hidden.id)!.tags).toEqual(['private-tag']);
    await engine.putPage(slug, { type: 'note', title: 'Now private', compiled_truth: 'Current private body', frontmatter: { visibility: 'private' } }, { sourceId });
    expect(await history(engine, slug, true)).toEqual([]); expect(await history(engine, slug, false)).toHaveLength(2);
  }
});
