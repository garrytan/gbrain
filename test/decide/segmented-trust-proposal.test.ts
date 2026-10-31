/** A managed trust proposal can supersede a fact whose entity page is segmented. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { decideTrustProposal } from '../../src/core/trust/decide.ts';
import { insertTrustProposal } from '../../src/core/trust/proposals.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const scratch: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  for (const backend of backends) {
    if (backend === 'pglite') {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-segmented-trust-db-'));
      scratch.push(dir);
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dir });
      await engine.initSchema();
      engines.push(engine);
    } else {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engines.push(pg.engine);
      closePostgres = pg.close;
    }
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const FACT_PAGE = `---\ntitle: Person Example\ntype: person\n---\n# Person Example\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | Person example leads research | fact | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n| 2 | Person example leads design | fact | 1.0 | private | medium | 2026-09-01 |  | chat |  |\n<!--- gbrain:facts:end -->\n\n`;
const config = (engine: BrainEngine) => ({ engine: engine.kind, embedding_disabled: true });

test('managed supersede_fact trust proposals accept on a segmented entity page', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-segmented-trust-proposal-'));
    scratch.push(dir);
    const root = join(dir, 'brain');
    mkdirSync(join(root, 'people'), { recursive: true });
    const sourceId = `segmented-${randomUUID().slice(0, 8)}`;
    const slug = 'people/person-example';
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, sourceId, root);
      const ctx = { engine, sourceId, remote: false as const, config: config(engine), dryRun: false,
        logger: { info() {}, warn() {}, error() {} } };
      const content = FACT_PAGE + 'Context line retained on the entity page.\n'.repeat(30_000);
      await submitPageMutation(ctx as never, { operation: 'put_page', params: { slug, content, request_id: randomUUID() } });
      const [page] = await engine.executeRaw<{ id: number; body_storage: string }>(
        'SELECT id, body_storage FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      expect(page?.body_storage).toBe('segmented');
      const facts = await engine.executeRaw<{ id: number; row_num: number; trust_tier: string }>(
        'SELECT id, row_num, trust_tier FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num', [sourceId, slug]);
      expect(facts.map(row => Number(row.row_num))).toEqual([1, 2]);

      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const oldFact = facts[0]!;
      const newFact = facts[1]!;
      const proposal = await insertTrustProposal(engine, { action: 'supersede_fact', sourceId,
        target: { table: 'facts', id: Number(oldFact.id) }, related: { table: 'facts', id: Number(newFact.id) }, proposer: 'test',
        before: { guard: 'test', old: { id: Number(oldFact.id), tier: oldFact.trust_tier }, new: { id: Number(newFact.id), tier: newFact.trust_tier } } });
      let outcome: unknown;
      try {
        outcome = await decideTrustProposal(engine, proposal.id, 'accept', { confirmation: { via: 'tty' }, config: config(engine) as never });
      } catch (error) {
        outcome = { thrown: true, code: (error as { code?: string }).code ?? null };
      }
      expect(outcome).toMatchObject({ status: 'accepted' });

      const [old] = await engine.executeRaw<{ expired_at: unknown; superseded_by: number | null }>(
        'SELECT expired_at, superseded_by FROM facts WHERE id=$1', [oldFact.id]);
      expect(old?.expired_at).not.toBeNull();
      expect(Number(old?.superseded_by)).toBe(Number(newFact.id));
      const [state] = await engine.executeRaw<{ status: string }>('SELECT status FROM trust_proposals WHERE id=$1', [proposal.id]);
      expect(state?.status).toBe('accepted');
      const stored = await materializeSegmentedBody(engine, Number(page!.id), sourceId);
      expect(parseFactsFence(stored.compiled_truth).facts.find(fact => fact.rowNum === 1)).toMatchObject({ active: false, supersededBy: 2 });
      expect(stored.compiled_truth).toContain('Context line retained on the entity page.');
      const canonical = readFileSync(join(root, `${slug}.md`), 'utf8');
      expect(parseFactsFence(canonical).facts.find(fact => fact.rowNum === 1)).toMatchObject({ active: false, supersededBy: 2 });
    });
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
    scratch.splice(scratch.indexOf(dir), 1);
  }
}, 180_000);
