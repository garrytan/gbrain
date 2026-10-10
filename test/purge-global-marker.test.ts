/**
 * Subject-'*' fact purges (purge_fact with all_subjects): the page snapshot
 * carries a count/latest marker instead of aggregating the whole '*' ledger
 * (GBRA-69: 4-5 ms per snapshot at 3,333 tombstones), and every overlay
 * resolves '*' tombstones against the fence rows of the text it overlays.
 *
 * Protects: the snapshot drops a '*'-purged row still in stored text and
 * lists it; a stale file that still carries a '*'-purged claim matches the
 * snapshot (the page-prepare overlay of incoming bytes), so a coordinated
 * write is not refused as drift; a stale import drops the row; remember of
 * the claim under another entity refuses with purged_content and put_page
 * drops its row; the marker follows the read's visibility filter. Real PGLite; Postgres too when
 * DATABASE_URL is set. The reconcile-plan invalidation probe lives in
 * test/persistence-reconcile.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { operations } from '../src/core/operations.ts';
import { fileMatchesSnapshot } from '../src/core/persistence/page-prepare.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const TEA = 'Likes green tea';
/** Each test purges its own claim: a '*' tombstone from one test would drop the next test's seed row. */
const claimOf = (slug: string) => `Gate code of ${slug.split('/')[1]} is 7731`;
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-global-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
const rowOf = (claim: string) => `| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
const ROW_TEA = `| 2 | ${TEA} | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
const pageBody = (slug: string) => {
  const title = slug.split('/')[1]!;
  return `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\nProse about ${title}.\n\n## Facts\n\n${fence([rowOf(claimOf(slug)), ROW_TEA])}\n`;
};

const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return e instanceof OperationError ? e.canonical ?? e.code : String((e as Error).message); }
}

/** Seed a page whose fence holds its claim and TEA, then purge the claim for every subject. */
async function purgedEverywhere(engine: BrainEngine, slug: string): Promise<string> {
  const claim = claimOf(slug);
  await importFromContent(engine, slug, pageBody(slug), { noEmbed: true, sourceId: 'default' });
  await runExtractFacts(engine, { slugs: [slug] });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1 AND entity_slug=$2', [claim, slug]);
  const purge = op('purge_fact');
  const dry = await purge.handler(ctx(engine), { id: Number(row!.id), all_subjects: true, dry_run: true }) as Record<string, any>;
  const done = await purge.handler(ctx(engine), { id: Number(row!.id), all_subjects: true, confirm: dry.confirm_token,
    expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
  expect(done.state).toBe('committed');
  expect(done.purge.subject).toBe('*');
  return claim;
}

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) await registerLocalWriter(engine, 'cli');
}), 120_000);
afterAll(async () => { await engines[0]?.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

describe("subject-'*' purges resolve per overlay", () => {
  test('the snapshot carries a marker, lists no unrelated tombstone, and drops a purged row still in stored text', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('DELETE FROM fact_purges');
      const slug = 'people/dana-example';
      const claim = await purgedEverywhere(engine, slug);
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      expect(snapshot.globalPurges).toMatchObject({ count: 1, world_only: false });
      expect(typeof snapshot.globalPurges!.latest).toBe('string');
      expect(snapshot.withdrawals.filter(w => w.purged)).toEqual([]);
      expect(snapshot.page.compiled_truth).not.toContain(claim);
      expect((await engine.readPageSnapshot(slug, { sourceId: 'default', excludePrivate: true }))!.globalPurges).toMatchObject({ count: 1, world_only: true });

      // A '*' tombstone naming a claim the stored text still holds: the snapshot drops the row and lists the tombstone.
      await engine.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash) VALUES ('default','world','*',gbrain_fact_fingerprint($1))`, [TEA]);
      try {
        const after = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
        expect(after.globalPurges).toMatchObject({ count: 2 });
        expect(after.page.compiled_truth).not.toContain(TEA);
        expect(after.withdrawals.filter(w => w.purged)).toHaveLength(1);
        const [stored] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id='default' AND slug=$1`, [slug]);
        expect(stored!.compiled_truth).toContain(TEA);
      } finally {
        await engine.executeRaw(`DELETE FROM fact_purges WHERE fact_hash=gbrain_fact_fingerprint($1)`, [TEA]);
      }
    }
  }), 60_000);

  test('a stale file still carrying the claim matches the snapshot (page-prepare overlay of incoming bytes); new prose does not', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/erin-example';
      await purgedEverywhere(engine, slug);
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      expect(snapshot.withdrawals.filter(w => w.purged)).toEqual([]);
      expect(await fileMatchesSnapshot(engine, slug, pageBody(slug), snapshot)).toBe(true);
      expect(await fileMatchesSnapshot(engine, slug, pageBody(slug) + '\nAn uncoordinated local edit.\n', snapshot)).toBe(false);
    }
  }), 60_000);

  test('a stale import drops the row; remember of the claim under another entity refuses with purged_content and put_page drops it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/finn-example';
      const claim = await purgedEverywhere(engine, slug);
      await importFromContent(engine, slug, pageBody(slug) + '\nEdited.\n', { noEmbed: true, sourceId: 'default' });
      const [page] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id='default' AND slug=$1`, [slug]);
      expect(page!.compiled_truth).not.toContain(claim);
      expect(page!.compiled_truth).toContain(TEA);
      expect(await codeOf(op('remember').handler(ctx(engine), { fact: claim, entity: 'people/other-example', provenance: 'test', request_id: randomUUID() })))
        .toBe('purged_content');
      const put = await codeOf(op('put_page').handler(ctx(engine), { slug: 'people/other-example', request_id: randomUUID(),
        content: `---\ntitle: Other\ntype: person\n---\n# Other\n\n## Facts\n\n${fence([rowOf(claim)])}\n` }));
      const [other] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id='default' AND slug='people/other-example'`);
      // put_page saves the page with the purged row dropped by the import overlay; the claim never lands.
      expect(put).toBe('ok');
      expect(other!.compiled_truth).not.toContain(claim);
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE fact=$1', [claim])).toHaveLength(0);
    }
  }), 60_000);
});
