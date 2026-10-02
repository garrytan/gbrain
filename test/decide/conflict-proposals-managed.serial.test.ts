/**
 * System One S9 proposal accept / undo on a MANAGED brain: the checked
 * supersede runs as a coordinator mutation (`decide_proposal`), so the
 * struck `## Facts` row in the canonical file, the facts row and the
 * proposal status publish as one unit, and undo restores them.
 *
 * Fails when: accept takes a legacy direct write (the managed writer guard
 * refuses it), the file and database disagree after accept or undo, or a
 * stale pair is superseded. Seeds through ordinary coordinated page writes
 * while unmanaged, then enables managed mode (managed-facts-writers pattern).
 * Serial: mutates GBRAIN_HOME and the persistence consumer.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { insertProposal } from '../../src/core/ai/decide/proposals-store.ts';
import { applyProposalAction } from '../../src/core/facts/proposal-supersede.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { testBackends } from '../helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-conflict-managed-db-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

const PAGE = `---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\n## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Alice leads research | fact | 1.0 | private | medium | 2026-01-01 |  | chat |  |
| 2 | Alice leads design | fact | 1.0 | private | medium | 2026-09-01 |  | chat |  |
| 3 | Alice likes tea | fact | 1.0 | private | medium | 2026-09-01 |  | chat |  |
<!--- gbrain:facts:end -->
`;

async function rows(engine: BrainEngine, sourceId: string) {
  return (await engine.executeRaw<{ id: number; row_num: number; expired_at: unknown; superseded_by: number | null }>(
    `SELECT id, row_num, expired_at, superseded_by FROM facts WHERE source_id = $1 ORDER BY row_num`, [sourceId]))
    .map((r) => ({ id: Number(r.id), row: Number(r.row_num), expired: r.expired_at !== null, superseded_by: r.superseded_by === null ? null : Number(r.superseded_by) }));
}

test('managed accept and undo publish the fence row, facts row and proposal status through the coordinator', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-conflict-managed-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `conflict-${randomUUID().slice(0, 8)}`;
    const config = { engine: engine.kind, embedding_disabled: true } as GBrainConfig;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        const ctx = { engine, sourceId, remote: false as const, config, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        await submitPageMutation(ctx as never, { operation: 'put_page', params: { slug: 'people/alice-example', content: PAGE, request_id: randomUUID() } });
        const seeded = await rows(engine, sourceId);
        expect(seeded.map((r) => [r.row, r.expired])).toEqual([[1, false], [2, false], [3, false]]);
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await expect(engine.executeRaw('UPDATE facts SET superseded_by = 1 WHERE source_id = $1', [sourceId])).rejects.toThrow(/writer_coordinator_required/);

        const [research, design, tea] = seeded.map((r) => r.id);
        const propose = async (newId: number, oldId: number, index: number) => (await insertProposal(engine, {
          source_id: sourceId, sweep_id: `managed-${sourceId}`, pair_index: index, new_fact_id: newId, old_fact_id: oldId,
          direction: 'new_supersedes_old', p_supersede: 0.8, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'jev-1.13.0' }))!;
        const file = join(root, 'people/alice-example.md');
        const original = readFileSync(file, 'utf-8');

        const id = await propose(design!, research!, 0);
        expect(await applyProposalAction(engine, id, 'accept', config)).toEqual({ id, action: 'accept', status: 'accepted' });
        const after = await rows(engine, sourceId);
        expect(after.find((r) => r.id === research)).toMatchObject({ expired: true, superseded_by: design });
        expect(after.find((r) => r.id === design)).toMatchObject({ expired: false });
        expect(readFileSync(file, 'utf-8')).toMatch(/~~Alice leads research~~[^\n]*superseded by #2/);
        const committed = await engine.executeRaw<{ operation: string; state: string }>(
          `SELECT operation, state FROM persistence_requests WHERE source_id = $1 AND operation = 'decide_proposal' ORDER BY sequence`, [sourceId]);
        expect(committed).toEqual([{ operation: 'decide_proposal', state: 'committed' }]);
        const [p] = await engine.executeRaw<{ status: string; after_state: string }>('SELECT status, after_state FROM decide_proposals WHERE id = $1', [id]);
        expect(p!.status).toBe('accepted');
        expect(JSON.parse(p!.after_state).fence.row).toMatchObject({ active: false, supersededBy: 2 });

        expect(await applyProposalAction(engine, id, 'undo', config)).toEqual({ id, action: 'undo', status: 'undone' });
        expect((await rows(engine, sourceId)).find((r) => r.id === research)).toMatchObject({ expired: false, superseded_by: null });
        expect(parseFactsFence(readFileSync(file, 'utf-8')).facts).toEqual(parseFactsFence(original).facts);

        // A pair whose old fact was superseded meanwhile is marked stale by the coordinator mutation, never applied.
        const first = await propose(tea!, research!, 1);
        const second = await propose(design!, research!, 2);
        expect((await applyProposalAction(engine, first, 'accept', config)).status).toBe('accepted');
        const struck = readFileSync(file, 'utf-8');
        expect(await applyProposalAction(engine, second, 'accept', config)).toEqual({ id: second, action: 'accept', status: 'stale', reason: 'old_fact_inactive' });
        expect(readFileSync(file, 'utf-8')).toBe(struck);
        expect((await rows(engine, sourceId)).find((r) => r.id === research)).toMatchObject({ superseded_by: tea });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);
