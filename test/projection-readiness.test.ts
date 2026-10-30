import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __resetProjectionReadinessCacheForTests, probeProjectionReadiness } from '../src/core/search/projection-readiness.ts';
import { withEnv } from './helpers/with-env.ts';
import { checkProjectionReadiness } from '../src/commands/doctor/checks/projection-readiness.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  for (const source of ['source-a', 'source-b']) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [source]);
  }
});

async function seed(kind = 'markdown', source = 'source-a', slug = 'example', frontmatter = {}) {
  await engine.executeRaw(
    `INSERT INTO pages (source_id,slug,title,type,page_kind,compiled_truth,chunker_version,frontmatter)
     VALUES ($1,$2,'Example','concept',$3,'canonical body',999,$4::text::jsonb)`,
    [source, slug, kind, JSON.stringify(frontmatter)],
  );
}

describe('canonical projection readiness', () => {
  test('empty scope is ready and an explicit empty grant never widens', async () => {
    expect((await probeProjectionReadiness(engine)).status).toBe('ready');
    await seed();
    expect((await probeProjectionReadiness(engine, { sourceIds: [] })).status).toBe('ready');
  });

  for (const kind of ['markdown', 'code']) {
    for (const revision of ['null', 'mismatched']) {
      test(`${kind} ${revision} seal is pending even at a newer chunker version`, async () => {
        await seed(kind);
        if (revision === 'mismatched') {
          await engine.executeRaw('UPDATE pages SET text_projection_revision=gen_random_uuid()');
        }
        const result = await probeProjectionReadiness(engine, { sourceId: 'source-a' });
        expect(result.status).toBe('projection_pending');
        expect(result.ready).toBe(false);
        expect(result.hint).toContain('incomplete');
        await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision');
        expect((await probeProjectionReadiness(engine, { sourceId: 'source-a' })).status).toBe('ready');
      });
    }
  }

  test('current rows do not mask pending rows and canonical rows do not need old chunks or queue entries', async () => {
    await seed('markdown', 'source-a', 'current');
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision');
    await seed('code', 'source-a', 'pending');
    await engine.executeRaw('DELETE FROM page_projection_jobs');
    expect((await probeProjectionReadiness(engine, { sourceId: 'source-a' })).status).toBe('projection_pending');
    expect((await probeProjectionReadiness(engine, { sourceId: 'source-a', pageKind: 'markdown' })).status).toBe('ready');
  });

  test('federated grants take precedence over scalar scope and duplicated slugs stay isolated', async () => {
    await seed('code', 'source-a');
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision');
    await seed('code', 'source-b');
    expect((await probeProjectionReadiness(engine, { sourceId: 'source-b', sourceIds: ['source-a'] })).status).toBe('ready');
    expect((await probeProjectionReadiness(engine, { sourceIds: ['source-a', 'source-b'] })).status).toBe('projection_pending');
  });

  for (const hidden of ['private', 'quarantine', 'deleted', 'archived']) {
    test(`hidden-only ${hidden} pending rows reveal no readiness signal`, async () => {
      await seed('markdown', 'source-b', 'hidden-example', hidden === 'private'
        ? { visibility: 'private' } : hidden === 'quarantine' ? { quarantine: true } : {});
      if (hidden === 'deleted') await engine.executeRaw('UPDATE pages SET deleted_at=NOW()');
      if (hidden === 'archived') await engine.executeRaw("UPDATE sources SET archived=true WHERE id='source-b'");
      const result = await probeProjectionReadiness(engine, { sourceIds: ['source-a', 'source-b'], excludePrivate: true });
      expect(result).toEqual({ status: 'ready', ready: true });
      expect(JSON.stringify(result)).not.toContain('hidden-example');
      expect(JSON.stringify(result)).not.toContain('source-b');
      if (hidden === 'private') {
        expect((await probeProjectionReadiness(engine, { excludePrivate: false })).status).toBe('projection_pending');
      }
    });
  }

  test('search type and excluded-prefix filters constrain the probe', async () => {
    await seed('markdown', 'source-a', 'excluded_%/example');
    expect((await probeProjectionReadiness(engine, { types: ['person'] })).status).toBe('ready');
    expect((await probeProjectionReadiness(engine, { excludeSlugPrefixes: ['excluded_%/'] })).status).toBe('ready');
    expect((await probeProjectionReadiness(engine, { excludeSlugPrefixes: ['excludedZZ/'] })).status).toBe('projection_pending');
  });

  test('probe errors and malformed results are unknown, without exposing error text', async () => {
    for (const executeRaw of [async () => { throw new Error('hidden-source database error'); }, async () => []]) {
      const result = await probeProjectionReadiness({ executeRaw } as any);
      expect(result.status).toBe('unknown');
      expect(result.ready).toBe(false);
      expect(JSON.stringify(result)).not.toContain('hidden-source');
    }
  });

  test('diagnostics issue one bound EXISTS and never mutate or repair', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const result = await probeProjectionReadiness({
      executeRaw: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return [{ pending: true }];
      },
    } as any, { sourceId: "source-'quote", excludePrivate: true });
    expect(result.status).toBe('projection_pending');
    // Besides the probe, at most the cache's read-only generation read runs.
    const probes = calls.filter(call => call.sql.includes('ORDER BY p.source_id, p.page_kind, p.slug LIMIT 1'));
    expect(probes).toHaveLength(1);
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(probes[0].sql).toContain('IS DISTINCT FROM');
    for (const call of calls) expect(call.sql).not.toMatch(/COUNT\(|UPDATE |INSERT |DELETE /);
    expect(probes[0].sql).not.toContain("source-'quote");
    expect(probes[0].params).toEqual(["source-'quote"]);
  });

  test('doctor distinguishes ready, pending and unknown without returning identifiers', async () => {
    expect((await checkProjectionReadiness(engine)).status).toBe('ok');
    await seed('code');
    const pending = await checkProjectionReadiness(engine, { sourceId: 'source-a' });
    expect(pending.status).toBe('warn');
    expect(pending.details).toEqual({ readiness: 'projection_pending', ready: false, pending: 1, failed: 0, sealable: 0, sealable_with_visual: 0,
      reimport: 0, ocr_required: 0, protected: 0, archived: 0, oldest_age_seconds: expect.any(Number), as_of: expect.any(String) });
    expect(JSON.stringify(pending)).not.toContain('source-a');
    const unknown = await checkProjectionReadiness({ executeRaw: async () => { throw new Error('private connection'); } } as any);
    expect(unknown.status).toBe('warn');
    expect(unknown.details).toEqual({ readiness: 'unknown', ready: false });
    expect(JSON.stringify(unknown)).not.toContain('private connection');
  });
});

/**
 * The readiness cache (Foundations 2, Lane F): a repeat search reuses the
 * last answer for the same normalized scope while the database-visible
 * generation (page clock, pages relation file, source archive flags) holds.
 */
describe('projection readiness cache', () => {
  const counted = () => {
    let probes = 0;
    const wrapped = { executeRaw: async (sql: string, params?: unknown[]) => {
      if (sql.includes('ORDER BY p.source_id, p.page_kind, p.slug LIMIT 1')) probes++;
      return engine.executeRaw(sql, params);
    } };
    return { engine: wrapped as unknown as PGLiteEngine, probes: () => probes };
  };
  beforeEach(() => { __resetProjectionReadinessCacheForTests(); });

  test('a repeat call for an equal scope reuses the answer; a page write invalidates it', async () => {
    await seed('markdown', 'source-a', 'current');
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision');
    const c = counted();
    expect((await probeProjectionReadiness(c.engine, { sourceIds: ['source-b', 'source-a'], types: ['concept'] })).status).toBe('ready');
    expect((await probeProjectionReadiness(c.engine, { sourceIds: ['source-a', 'source-b', 'source-a'], types: ['concept'] })).status).toBe('ready');
    expect(c.probes()).toBe(1);
    await seed('markdown', 'source-a', 'pending');
    expect((await probeProjectionReadiness(c.engine, { sourceIds: ['source-a', 'source-b'], types: ['concept'] })).status).toBe('projection_pending');
    expect(c.probes()).toBe(2);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision');
    expect((await probeProjectionReadiness(c.engine, { sourceIds: ['source-a', 'source-b'], types: ['concept'] })).status).toBe('ready');
    expect(c.probes()).toBe(3);
  });

  test('every scope input is part of the key', async () => {
    await seed('code', 'source-a', 'excluded/pending', { visibility: 'private' });
    const c = counted();
    const scopes = [{}, { sourceId: 'source-a' }, { sourceIds: ['source-b'] }, { excludePrivate: true }, { pageKind: 'markdown' },
      { types: ['person'] }, { excludeSlugPrefixes: ['excluded/'] }];
    const statuses = [];
    for (const scope of scopes) statuses.push((await probeProjectionReadiness(c.engine, scope)).status);
    expect(statuses).toEqual(['projection_pending', 'projection_pending', 'ready', 'ready', 'ready', 'ready', 'ready']);
    expect(c.probes()).toBe(scopes.length);
  });

  test('restoring an archived source with pending pages invalidates a cached ready', async () => {
    await seed('markdown', 'source-b', 'pending');
    await engine.executeRaw("UPDATE sources SET archived=true WHERE id='source-b'");
    const c = counted();
    expect((await probeProjectionReadiness(c.engine)).status).toBe('ready');
    await engine.executeRaw("UPDATE sources SET archived=false WHERE id='source-b'");
    expect((await probeProjectionReadiness(c.engine)).status).toBe('projection_pending');
    expect(c.probes()).toBe(2);
  });

  test('an unknown answer is never reused, and GBRAIN_PROJECTION_READINESS_CACHE=0 always probes', async () => {
    let fail = true;
    const flaky = { executeRaw: async (sql: string, params?: unknown[]) => {
      if (sql.includes('ORDER BY p.source_id, p.page_kind, p.slug LIMIT 1') && fail) throw new Error('transient');
      return engine.executeRaw(sql, params);
    } } as unknown as PGLiteEngine;
    expect((await probeProjectionReadiness(flaky)).status).toBe('unknown');
    fail = false;
    expect((await probeProjectionReadiness(flaky)).status).toBe('ready');
    const c = counted();
    await withEnv({ GBRAIN_PROJECTION_READINESS_CACHE: '0' }, async () => {
      await probeProjectionReadiness(c.engine);
      await probeProjectionReadiness(c.engine);
    });
    expect(c.probes()).toBe(2);
  });

  test('nothing is cached while a transaction is in flight', async () => {
    let probes = 0;
    const busy = { executeRaw: async (sql: string, params?: unknown[]) => {
      if (sql.includes('ORDER BY p.source_id, p.page_kind, p.slug LIMIT 1')) probes++;
      const rows = await engine.executeRaw<Record<string, unknown>>(sql, params);
      return sql.includes('pg_current_snapshot') ? rows.map(row => ({ ...row, quiescent: false })) : rows;
    } } as unknown as PGLiteEngine;
    await probeProjectionReadiness(busy);
    await probeProjectionReadiness(busy);
    expect(probes).toBe(2);
  });
});
