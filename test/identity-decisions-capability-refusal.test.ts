/**
 * Sync's identity hook (syncIdentityDecisions, the step performSync runs after every sync) passes an engine capability
 * refusal on and keeps every other failure fail-open.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a capability refusal (`engine_capability_missing`) from the decision reconcile or the company sweep
 *    reaches the caller; any other failure in either step is logged with the same line as before and swallowed, and a
 *    sweep that does not fail logs and links exactly as before.
 *  - Regression: a catch-all turns the Rust engine's refusal of a step it does not serve (listEntityKeyRows, table
 *    `pages`) into a log line, so a sync on that engine skips the company sweep and still reports success.
 *  - Why existing coverage misses it: entity-company-auto-link.test.ts runs on SQL engines, which never refuse; the
 *    writer-release parity test sees the refusal only on the Rust arm.
 *  - Seam: real PGLite (and Postgres with DATABASE_URL); one member of the engine is replaced through a Proxy to
 *    throw. Made-up names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { hasPendingMigrations } from '../src/core/migrate-pending.ts';
import { syncIdentityDecisions } from '../src/core/entities/identity-decisions.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';

const refusal = (member: string) => Object.assign(new Error(`${member} (table pages)`), { code: 'engine_capability_missing' });
const RECONCILE_FAILED = '[dedupe] duplicate decisions were not reconciled after this sync: connection reset (gbrain dedupe reconcile retries)';
const SWEEP_FAILED = '[dedupe] companies that share an id were not linked after this sync: connection reset (gbrain dedupe reconcile retries)';
const LINKED = '[dedupe] linked 1 and unlinked 0 company group(s) that share an id';

for (const backend of testBackends()) describe(backend, () => {
  let engine: BrainEngine;
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
  let clone: { close: () => Promise<void> } | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') { template = await persistencePostgresTemplate(requirePostgresTestDatabase()); return; }
    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    await hasPendingMigrations(pglite);
    engine = pglite;
  }, 120_000);
  afterAll(async () => {
    if (backend === 'postgres') { await clone?.close(); await template?.dispose(); return; }
    await engine.disconnect();
  });
  beforeEach(async () => {
    if (backend === 'postgres') {
      await clone?.close();
      const c = await template!.clone();
      engine = c.engine; clone = c;
      await hasPendingMigrations(engine);
    } else {
      await resetPgliteState(engine as PGLiteEngine);
    }
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING`);
    for (const sourceId of ['default', 'source-b']) {
      await engine.putPage('companies/acme-example', {
        type: 'company', title: 'Acme Example', compiled_truth: 'Acme Example.', timeline: '',
        frontmatter: { linkedin: 'https://www.linkedin.com/company/acme-example/', website: 'https://acme-example.com' },
      } as never, { sourceId });
    }
  }, 60_000);

  /** The engine with `member` replaced by one that throws `error`; every other member is the real one. */
  const failing = (member: string, error: Error) => new Proxy(engine, {
    get(target, key, receiver) {
      if (key === member) return async () => { throw error; };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as BrainEngine;
  const sweep = async (on: BrainEngine) => {
    const lines: string[] = [];
    await syncIdentityDecisions(on, 'source-b', line => lines.push(line), ['companies/acme-example']);
    return lines;
  };
  const linked = async () => (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM entity_identities WHERE established_by = 'dedupe:auto'`))[0]!.n;

  test('a sweep that does not fail logs and links as before', async () => {
    expect(await sweep(engine)).toEqual([LINKED]);
    expect(await linked()).toBe(2);
  });

  test('another failure in the company sweep is logged with the same line and swallowed', async () => {
    expect(await sweep(failing('listEntityKeyRows', new Error('connection reset')))).toEqual([SWEEP_FAILED]);
    expect(await linked()).toBe(0);
  });

  test('another failure in the decision reconcile is logged with the same line and swallowed', async () => {
    expect(await sweep(failing('listIdentityDecisions', new Error('connection reset')))).toEqual([RECONCILE_FAILED, SWEEP_FAILED]);
    expect(await linked()).toBe(0);
  });

  test('a capability refusal from the company sweep reaches the caller', async () => {
    const lines: string[] = [];
    await expect(syncIdentityDecisions(failing('listEntityKeyRows', refusal('listEntityKeyRows')), 'source-b', line => lines.push(line), ['companies/acme-example']))
      .rejects.toMatchObject({ code: 'engine_capability_missing', message: 'listEntityKeyRows (table pages)' });
    expect(lines).toEqual([]);
    expect(await linked()).toBe(0);
  });

  test('a capability refusal from the decision reconcile reaches the caller', async () => {
    const lines: string[] = [];
    await expect(syncIdentityDecisions(failing('listIdentityDecisions', refusal('listIdentityDecisions')), 'source-b', line => lines.push(line), ['companies/acme-example']))
      .rejects.toMatchObject({ code: 'engine_capability_missing', message: 'listIdentityDecisions (table pages)' });
    expect(lines).toEqual([]);
  });
});
