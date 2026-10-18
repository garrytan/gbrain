/**
 * #6543 (D1): `gbrain repair <kind> --apply` stopped at the first accepted-but-pending write, so an approved set of N
 * slow items needed up to N+1 reruns. Now a pending item is kept (its receipt, the cursor before it) and the run goes on:
 * later items are admitted without a publication wait, at most a window of receipts stays unresolved, and they settle
 * against one shared wait budget. Every early stop settles first; a crash leaves the cursor before the first unresolved
 * receipt, so the same command resumes. A run with no live consumer still stops at the first pending write and names it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { resolveRepairScope, runRepair, type RepairHandler, type RepairItem } from '../src/core/repair/core.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { getCliOptions, setCliOptions } from '../src/core/cli-options.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-repair-pending-'));
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  if (testBackends().includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
  rmSync(dataDir, { recursive: true, force: true });
});

const ctxFor = (engine: BrainEngine, sourceId: string, writeWaitMs?: number) => ({ engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
  dryRun: false, logger: quiet, ...(writeWaitMs === undefined ? {} : { writeWaitMs }) }) as never;
const page = (body: string) => `---\ntype: note\ntitle: Example\n---\n${body}\n`;

async function brain(run: (engine: BrainEngine, source: string) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(dataDir, 'case-'));
    const source = `repair-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'");
        await engine.executeRaw("DELETE FROM config WHERE key LIKE 'persistence.limits.%'");
        await engine.executeRaw('UPDATE sources SET archived=true WHERE archived IS NOT TRUE');
        const root = join(dir, source); mkdirSync(root);
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
        await claimWorktree(engine, source, root);
        await run(engine, source);
      });
    } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
  }
}

async function pagesWithHistory(engine: BrainEngine, sourceId: string, slugs: string[]) {
  for (const slug of slugs) await submitPageMutation(ctxFor(engine, sourceId), { operation: 'put_page', params: { slug, content: page(`Body of ${slug}.`), request_id: randomUUID() } });
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
    `INSERT INTO timeline_entries(page_id,date,source,summary,detail) SELECT id,'2026-07-01','legacy','History of '||slug,'' FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])`,
    [sourceId, slugs]), TEST_WRITE_ATTRIBUTION));
}
const marked = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ slug: string }>(
  `SELECT slug FROM pages WHERE source_id=$1 AND timeline LIKE '%gbrain:materialized%' ORDER BY slug`, [sourceId])).map(r => r.slug);
/** Slows the first `first` publications by `slowMs` and every later one by `restMs`. */
function slowPublications(slowMs: number, opts: { first?: number; restMs?: number } = {}) {
  let seen = 0;
  installFaultHook(async point => {
    if (point !== 'consumer:prepared') return;
    const ms = seen++ < (opts.first ?? Infinity) ? slowMs : opts.restMs ?? 0;
    if (ms) await new Promise(resolve => setTimeout(resolve, ms));
  });
}
async function withWriteWait<T>(writeWaitMs: number, run: () => Promise<T>): Promise<T> {
  const previous = getCliOptions();
  setCliOptions({ ...previous, writeWaitMs });
  try { return await run(); } finally { setCliOptions(previous); }
}
async function eventually(read: () => Promise<unknown>, expected: unknown, ms = 15_000) {
  const until = Date.now() + ms;
  let last: unknown;
  while (Date.now() < until) { last = await read(); if (JSON.stringify(last) === JSON.stringify(expected)) return; await new Promise(r => setTimeout(r, 100)); }
  expect(last).toEqual(expected);
}

describe('#6543 D1: repair apply continues past accepted-but-pending writes', () => {
  test('under --wait 0 one run admits all three slow items, which publish without a rerun (master: one item per run)', async () => {
    await brain(async (engine, source) => {
      await pagesWithHistory(engine, source, ['notes/a', 'notes/b', 'notes/c']);
      const scope = await resolveRepairScope(engine);
      slowPublications(1_000);
      const first = await withWriteWait(0, async () => (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('timeline', scope));
      expect(first).toMatchObject({ applied: 0, complete: false, stopped: { reason: 'write_pending' } });
      expect(first.pending?.map(p => p.item)).toEqual([`${source}:notes/a`, `${source}:notes/b`, `${source}:notes/c`]);
      expect(first.stopped!.message).toContain('3 repairs were accepted and are still pending publication');
      await eventually(() => marked(engine, source), ['notes/a', 'notes/b', 'notes/c']);
      const again = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('timeline', scope);
      expect(again).toMatchObject({ complete: true });
      expect(again.stopped).toBeUndefined();
    });
  }, 120_000);

  test('a first publication slower than the write wait no longer stops the run: the rest settle in one shared wait and one run completes', async () => {
    await brain(async (engine, source) => {
      await pagesWithHistory(engine, source, ['notes/a', 'notes/b', 'notes/c']);
      const scope = await resolveRepairScope(engine);
      slowPublications(2_500, { first: 1, restMs: 200 });
      const result = await withWriteWait(2_000, async () => (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('timeline', scope));
      expect(result.stopped).toBeUndefined();
      expect(result).toMatchObject({ applied: 3, complete: true });
      expect(await marked(engine, source)).toEqual(['notes/a', 'notes/b', 'notes/c']);
      expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='repair'")).toEqual([]);
    });
  }, 120_000);

  test('more than 100 slow repairs finish in one run under the shipped outstanding limits, and a lowered cap only narrows the window', async () => {
    await brain(async (engine, source) => {
      const slugs = Array.from({ length: 105 }, (_, i) => `notes/p${String(i).padStart(3, '0')}`);
      await pagesWithHistory(engine, source, slugs);
      const scope = await resolveRepairScope(engine);
      slowPublications(2_500, { first: 1, restMs: 5 });
      const result = await withWriteWait(2_000, async () => (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('timeline', scope));
      expect(result.stopped).toBeUndefined();
      expect(result).toMatchObject({ applied: 105, complete: true, failed: [] });
      expect((await marked(engine, source)).length).toBe(105);
    });
    await brain(async (engine, source) => {
      const slugs = Array.from({ length: 20 }, (_, i) => `notes/q${String(i).padStart(2, '0')}`);
      await pagesWithHistory(engine, source, slugs);
      await engine.setConfig('persistence.limits.principal_outstanding', '8');
      const scope = await resolveRepairScope(engine);
      slowPublications(2_500, { first: 1, restMs: 20 });
      const result = await withWriteWait(2_000, async () => (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('timeline', scope));
      expect(result.stopped).toBeUndefined();
      expect(result).toMatchObject({ applied: 20, complete: true });
    });
  }, 240_000);

  test('a run that dies after admitting pending items leaves the cursor before the first of them, and the same command resumes', async () => {
    await brain(async (engine, source) => {
      await pagesWithHistory(engine, source, ['notes/a', 'notes/b', 'notes/c']);
      const scope = await resolveRepairScope(engine);
      const spec = repairSpec('timeline');
      let calls = 0;
      const dying = { ...spec.handler, apply: async (...args: Parameters<typeof spec.handler.apply>) => {
        if (++calls === 3) throw Object.assign(new Error('process died'), { name: 'AbortError' });
        return spec.handler.apply(...args);
      } };
      slowPublications(1_000);
      await expect(runRepair(ctxFor(engine, source, 0), dying, scope, { apply: true, spec, embed: false })).rejects.toThrow('process died');
      const [row] = await engine.executeRaw<{ completed_keys: Array<{ cursor: unknown; run_id: string }> }>("SELECT completed_keys FROM op_checkpoints WHERE op='repair'");
      expect(row!.completed_keys[0]).toMatchObject({ cursor: null });
      installFaultHook(undefined);
      const resumed = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet })).run('timeline', scope);
      expect(resumed).toMatchObject({ complete: true, resumed_from: null });
      expect(await marked(engine, source)).toEqual(['notes/a', 'notes/b', 'notes/c']);
    });
  }, 120_000);

  test('with no live consumer the run still stops at the first pending write and names the owner', async () => {
    await brain(async (engine, source) => {
      await pagesWithHistory(engine, source, ['notes/a', 'notes/b', 'notes/c']);
      const scope = await resolveRepairScope(engine);
      const spec = repairSpec('timeline');
      slowPublications(1_000);
      const result = await runRepair(ctxFor(engine, source, 0), spec.handler, scope, { apply: true, spec, embed: false,
        publicationOwner: async () => ({ alive: false, owner: 'the serve process (pid 4242), which reports restart_required' }) });
      expect(result).toMatchObject({ applied: 0, complete: false, stopped: { reason: 'write_pending', fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', source, '--json'], actor: 'host_admin' } } });
      expect(result.stopped!.message).toContain('nothing here publishes it (the serve process (pid 4242), which reports restart_required)');
      expect(result.pending).toEqual([{ item: `${source}:notes/a`, request_id: expect.any(String) }]);
    });
  }, 120_000);
  test('a preview-bound apply runs its last item (which retires the approved set) only after every earlier receipt is accounted for', async () => {
    await brain(async (engine, source) => {
      const scope = await resolveRepairScope(engine);
      const spec = repairSpec('failed-writes');
      const attempts: number[] = [];
      let pendingIds = true;
      const item = (id: number): RepairItem => ({ cursor: { phase: 0, id }, source_id: source, slug: `notes/s${id}`, chars: 1, action: 'replay' });
      const handler: RepairHandler = { kind: 'failed-writes', embeds: false,
        async plan(_engine, _scope, after) { return { items: [0, 1, 2].map(item).filter(i => !after || i.cursor.id > after.id), residuals: {}, preview_hash: 'h' }; },
        async apply(_ctx, it) {
          attempts.push(it.cursor.id);
          if (pendingIds && it.cursor.id < 2) {
            const error = new OperationError('write_pending', 'The write is accepted and is still pending.', 'wait');
            error.writeRequest = { request_id: randomUUID(), state: 'queued', retry_after_ms: 250 };
            throw error;
          }
          return { applied: true, outcome: 'replayed' };
        } };
      const alive = async () => ({ alive: true, owner: 'this process' });
      const stopped = await runRepair(ctxFor(engine, source, 0), handler, scope, { apply: true, spec, explicit: true, expect: 'h', publicationOwner: alive });
      expect(attempts).toEqual([0, 1]);
      expect(stopped).toMatchObject({ applied: 0, complete: false, stopped: { reason: 'write_pending' } });
      expect(stopped.pending?.map(p => p.item)).toEqual([`${source}:notes/s0`, `${source}:notes/s1`]);
      pendingIds = false; attempts.length = 0;
      const resumed = await runRepair(ctxFor(engine, source, 0), handler, scope, { apply: true, spec, explicit: true, expect: 'h', publicationOwner: alive });
      expect(attempts).toEqual([0, 1, 2]);
      expect(resumed).toMatchObject({ applied: 3, complete: true, resumed_from: null });
    });
  }, 60_000);
});
