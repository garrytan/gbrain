/**
 * Remote get_versions of a page whose storage changed since a version was taken (Wave B PR 2, fix lane K, review O1).
 *
 * 1. Protects: a remote caller's get_versions (metadata and include_body) lists a segmented version of a page that was
 *    later demoted to inline storage with its read-projection size (total_bytes, the size get_page reported while it
 *    was live), never its stored body_bytes; and lists an inline version of a page later promoted to segmented storage
 *    as the inline snapshot it is. Local reads list both too.
 * 2. Fails when: openSegmentedBody refuses every generation of a page whose live row is inline ("Page N is not a
 *    segmented page"), so remote get_versions throws for every page that was segmented and later demoted.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { importSegmented } from '../helpers/segmented-privacy-fixture.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
let engine: BrainEngine;
const ctx = (remote: boolean): OperationContext => ({ engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote,
  sourceId: 'default', emitResponseMeta: () => {}, transport: remote ? 'http' : 'cli', ...(remote ? { auth: { token: 'fixture', clientId: 'versions-client',
    principal: { kind: 'oauth_client', id: 'versions-client' }, scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } } : {}) } as unknown as OperationContext);
const call = async (name: string, params: Record<string, unknown>, remote = true) => await op(name).handler(ctx(remote), params) as any;

function filler(bytes: number, tag: string): string {
  const parts: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const part = `## Section ${tag} ${i}\n\n${`Public notes on launch planning and roadmap review for week ${i}. `.repeat(30)}\n\n`;
    parts.push(part);
    n += part.length;
  }
  return parts.join('');
}
const takes = `<!--- gbrain:takes:begin -->\n${'Hidden take about pricing strategy. '.repeat(8000)}\n<!--- gbrain:takes:end -->\n`;
const content = (body: string) => `---\ntitle: Versions probe\ntype: note\n---\n\n${body}`;
const storage = async (slug: string) => (await engine.executeRaw<{ body_storage: string }>(
  "SELECT body_storage FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.body_storage;
const snapshot = (slug: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.createVersion(slug, { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));

for (const kind of testBackends()) {
  describe(`get_versions across a storage change (${kind})`, () => {
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close(); });

    test('a segmented version of a page demoted to inline reports its projected size', async () => {
      const slug = 'notes/demoted-versions';
      const id = await importSegmented(engine, slug, content(`${filler(1_400_000, 'big')}\n\n${takes}`));
      await snapshot(slug);
      const projected = (await call('get_page', { slug, body: 'none' })).size.total_bytes as number;
      const [stored] = await engine.executeRaw<{ body_bytes: number }>('SELECT body_bytes FROM pages WHERE id=$1', [id]);
      expect(projected).toBeLessThan(Number(stored!.body_bytes));

      await importFromContent(engine, slug, content('A short page now.\n'), { sourceId: 'default', noEmbed: true });
      expect(await storage(slug)).toBe('inline');

      const meta = (await call('get_versions', { slug })) as Array<Record<string, unknown>>;
      const segmented = meta.filter(v => v.body_storage === 'segmented');
      expect(segmented.length).toBeGreaterThan(0);
      for (const v of segmented) {
        expect(v.body_bytes).toBeUndefined();
        expect(v.total_bytes).toBe(projected);
      }
      const full = (await call('get_versions', { slug, include_body: true })) as Array<Record<string, any>>;
      const fullSegmented = full.filter(v => v.body_storage === 'segmented');
      expect(fullSegmented.length).toBe(segmented.length);
      for (const v of fullSegmented) {
        expect(v.body_bytes).toBeUndefined();
        expect(v.body_ref.total_bytes).toBe(projected);
      }
      expect(JSON.stringify([meta, full])).not.toContain(String(stored!.body_bytes));
      const local = (await call('get_versions', { slug }, false)) as Array<Record<string, unknown>>;
      expect(local.filter(v => v.body_storage === 'segmented').every(v => Number(v.body_bytes) === Number(stored!.body_bytes))).toBe(true);
    }, 240_000);

    test('an inline version of a page promoted to segmented storage lists as an inline snapshot', async () => {
      const slug = 'notes/promoted-versions';
      await importFromContent(engine, slug, content('Small first draft about inline history.\n'), { sourceId: 'default', noEmbed: true });
      await snapshot(slug);
      await importSegmented(engine, slug, content(filler(1_400_000, 'grown')));
      expect(await storage(slug)).toBe('segmented');
      const meta = (await call('get_versions', { slug })) as Array<Record<string, unknown>>;
      expect(meta.length).toBeGreaterThan(0);
      expect(meta.some(v => v.body_storage === 'segmented')).toBe(false);
      const full = (await call('get_versions', { slug, include_body: true })) as Array<Record<string, any>>;
      expect(full.some(v => String(v.compiled_truth).includes('Small first draft about inline history.'))).toBe(true);
    }, 240_000);
  });
}
