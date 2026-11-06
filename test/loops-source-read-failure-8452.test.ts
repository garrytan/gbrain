/** #8452: an unavailable source census is not an empty, complete inbox. Synthetic fixtures on both engines. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { upsertOpenLoop } from '../src/core/loops/loops-store.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const openLoops = loopsOperations.find(op => op.name === 'open_loops')!;
for (const backend of testBackends()) describe(`#8452 unavailable loop coverage (${backend})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (backend === 'pglite') {
      const db = new PGLiteEngine();
      await db.connect({}); await db.initSchema(); engine = db; close = () => db.disconnect();
    } else {
      const db = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      engine = db.engine; close = db.close;
    }
    await engine.executeRaw(`INSERT INTO sources(id,name,config,last_sync_at) VALUES
      ('mail-a','mail-a','{"kind":"google"}'::jsonb,now()),
      ('notes-a','notes-a','{}'::jsonb,NULL),
      ('outside-secret','outside-secret','{"kind":"google"}'::jsonb,now())`);
    for (const sourceId of ['mail-a', 'outside-secret']) await upsertOpenLoop(engine, {
      sourceId, dedupKey: 'synthetic', loopType: 'unanswered_inbound', counterpartyEmail: 'alice@example.invalid',
      summary: `${sourceId} reply owed`, evidence: [{ quote: 'synthetic private quote' }], detector: 'deterministic_thread',
    });
  }, 120_000);
  afterAll(async () => { await close?.(); });

  async function call(opts: { fail?: boolean; remote?: boolean; flat?: boolean; sourceId?: string; populated?: boolean } = {}) {
    let reads = 0;
    const wrapped = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return function(this: BrainEngine, sql: string, ...args: unknown[]) {
        if (sql.includes('SELECT id, last_sync_at, config FROM sources WHERE archived')) {
          reads++;
          if (opts.fail) throw new Error('connection failed: outside-secret credential-canary');
        }
        return Reflect.apply(target.executeRaw, target, [sql, ...args]);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const notices: Notice[] = [];
    const ctx = { engine: wrapped, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false,
      remote: opts.remote ?? true, sourceId: opts.sourceId ?? (opts.populated ? 'mail-a' : 'notes-a'),
      auth: { allowedSources: ['notes-a', 'mail-a'] }, emitNotice: (n: Notice) => notices.push(n) } as unknown as OperationContext;
    const result = await openLoops.handler(ctx, { include_context: false, source_id: opts.sourceId ?? (opts.populated ? 'mail-a' : 'notes-a'),
      ...(opts.flat ? { group_by: 'none' } : {}) }) as Record<string, any>;
    expect(reads).toBe(1);
    return { result, notices };
  }

  for (const flat of [false, true]) for (const populated of [false, true]) {
    test(`source read failure preserves partial scoped results (flat=${flat}, populated=${populated})`, async () => {
      const { result, notices } = await call({ fail: true, flat, populated });
      expect(result.no_google_sources).toBeNull();
      expect(result.completeness).toBe('partial');
      expect(result.stale).toBe(true);
      expect(result.count).toBe(populated ? 1 : 0);
      expect(result.sources).toEqual([]);
      expect(result.held).toEqual([]);
      expect(notices.map(n => n.code)).toContain('loops_source_read_failed');
      expect(notices.map(n => n.code)).not.toContain('loops_no_google_in_scope');
      expect(JSON.stringify({ result, notices })).not.toContain('outside-secret');
      expect(JSON.stringify({ result, notices })).not.toContain('credential-canary');
      expect(JSON.stringify(result)).not.toContain('synthetic private quote');
      expect(result).not.toHaveProperty('text');
      const recovered = await call({ flat, populated });
      expect(recovered.result.no_google_sources).toBe(!populated);
      expect(recovered.result.completeness).toBe('complete');
      expect(recovered.notices.map(n => n.code)).not.toContain('loops_source_read_failed');
    });
  }

  test('trusted digest distinguishes an unavailable census from stale syncs and a genuinely empty scope', async () => {
    const { result } = await call({ remote: false, fail: true });
    expect(result.no_google_sources).toBeNull();
    expect(result.completeness).toBe('partial');
    expect(result.text).toContain('source freshness could not be read');
    expect(result.text).not.toContain('No google source is connected');
    expect(result.text).not.toContain('You are clean');
    expect(result.text).not.toContain('have not synced recently');
    expect((await call({ remote: false })).result.text).toContain('No google source is connected');
  });
});
