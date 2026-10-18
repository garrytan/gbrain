/**
 * #6511 (GBRA-79 wave 16, G3.1 [R5]): the fact purge's planning read of the
 * historical journal (`findRequestsCarrying`, an unindexable substring search)
 * can hit the statement budget on a large journal. That timeout is
 * deterministic, not contention: the plan fails with the typed
 * `purge_lookup_timeout`, nothing is purged, tombstoned or redacted, no page
 * receipt is persisted for the dry run, and a following write to the source
 * commits. Master: the raw 57014 escaped the handler as an untyped error.
 *
 * Semantic injection: `installFaultHook('purge:carrying_lookup')` makes the
 * named read fail; no SQL substring. PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { CODES } from '../src/core/error-registry.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const CLAIM = 'Door code is 4417';
const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nProse about ${title}.\n\n## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->\n`;
const op = (name: string) => operations.find(o => o.name === name)!;
const timeout57014 = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

for (const backend of testBackends()) describe(`[${backend}] #6511 purge_fact planning lookup timeout`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-6511-fact-${backend}-`));
  const context = (): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' });
  const call = (name: string, params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, () => op(name).handler(context(), params)) as Promise<Record<string, any>>;
  const count = async (sql: string, params: unknown[] = []) => Number((await engine.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
  const snapshot = async () => ({
    facts: await count('facts WHERE source_id=$1', ['default']), factPurges: await count('fact_purges'), pagePurges: await count('page_purges'),
    requests: await count('persistence_requests'), carrying: await count("persistence_requests WHERE strpos(lower(intent::text), lower($1)) > 0", [CLAIM]),
  });

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    await importFromContent(engine, 'people/door', page('Door'), { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(engine, { slugs: ['people/door'] });
    const carrier = await call('put_page', { slug: 'notes/door-carrier', content: `---\ntitle: Carrier\ntype: note\n---\nSomeone wrote: ${CLAIM}.\n`, request_id: randomUUID() });
    expect(carrier.state).toBe('committed');
  }, 120_000);
  afterAll(async () => {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine); await engine.disconnect(); await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
  afterEach(() => installFaultHook(undefined));

  test('a statement timeout of the planning lookup is the typed purge_lookup_timeout; nothing is purged, no receipt is stored, the source keeps moving', async () => {
    const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1 AND source_id=$2', [CLAIM, 'default']);
    const before = await snapshot();
    expect(before.carrying).toBeGreaterThan(0);
    let seen = 0;
    installFaultHook(point => { if (point === 'purge:carrying_lookup') { seen++; throw timeout57014(); } });
    let error: OperationError | undefined;
    try { await call('purge_fact', { id: Number(fact!.id), dry_run: true }); } catch (e) { error = e as OperationError; }
    expect(error).toBeInstanceOf(OperationError);
    expect(error!.code).toBe('purge_lookup_timeout');
    expect(error!.message).toContain('could not finish');
    expect(error!.message).toContain('Do not assume');
    expect(error!.fix).toMatchObject({ argv: ['gbrain', 'repair', 'request-indexes', '--json'] });
    expect(seen).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect(await count("persistence_requests WHERE operation='purge_fact'")).toBe(0);
    installFaultHook(undefined);
    const dry = await call('purge_fact', { id: Number(fact!.id), dry_run: true });
    expect(dry).toMatchObject({ dry_run: true, action: 'purge_fact' });
    expect(await snapshot()).toEqual(before);
    const written = await call('put_page', { slug: 'notes/after-timeout', content: '---\ntitle: After\ntype: note\n---\nStill moving.\n', request_id: randomUUID() });
    expect(written.state).toBe('committed');
  }, 60_000);

  test('the error registry classifies purge_lookup_timeout as a non-retryable caller error the brain host administers', () => {
    expect(CODES.purge_lookup_timeout).toMatchObject({ class: 'caller', retryable: false, actor: 'host_admin', docs: 'docs/guides/write-refusals.md#purge_lookup_timeout' });
  });

  test('any other failure of the planning lookup is rethrown untyped', async () => {
    const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1 AND source_id=$2', [CLAIM, 'default']);
    installFaultHook(point => { if (point === 'purge:carrying_lookup') throw Object.assign(new Error('connection reset'), { code: '08006' }); });
    await expect(call('purge_fact', { id: Number(fact!.id), dry_run: true })).rejects.toThrow('connection reset');
  });
});
