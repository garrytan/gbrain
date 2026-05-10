/**
 * v0.31 E2E — Cross-session recall test against real Postgres (parity gate).
 *
 * Mirrors test/facts-separation-pglite.test.ts. Skips gracefully when
 * DATABASE_URL is unset.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => { if (RUN) await setupDB(); });
afterAll(async () => { if (RUN) await teardownDB(); });

d("Cross-session recall test (Postgres)", () => {
  test('cross-session recall: insert in session-A, recall via entity from session-B', async () => {
    const engine = getEngine();
    await engine.insertFact(
      {
        fact: 'sample event Tuesday',
        kind: 'event',
        entity_slug: 'travel',
        source: 'mcp:extract_facts',
        source_session: 'session-A',
        visibility: 'world',
      },
      { source_id: 'default' },
    );

    const byEntity = await engine.listFactsByEntity('default', 'travel');
    expect(byEntity.length).toBe(1);
    expect(byEntity[0].fact).toBe('sample event Tuesday');
    expect(byEntity[0].source_session).toBe('session-A');

    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
    const bySince = await engine.listFactsSince('default', eightHoursAgo);
    expect(bySince.find(f => f.fact === 'sample event Tuesday')).toBeDefined();

    const sessionA = await engine.listFactsBySession('default', 'session-A');
    expect(sessionA.length).toBe(1);

    const sessionB = await engine.listFactsBySession('default', 'session-B');
    expect(sessionB.length).toBe(0);
  });

  test('expireFact + listSupersessions on real Postgres', async () => {
    const engine = getEngine();
    const r1 = await engine.insertFact(
      { fact: 'old', kind: 'fact', entity_slug: 'super-pg', source: 'test' },
      { source_id: 'default' },
    );
    const r2 = await engine.insertFact(
      { fact: 'new', kind: 'fact', entity_slug: 'super-pg', source: 'test' },
      { source_id: 'default', supersedeId: r1.id },
    );
    expect(r2.status).toBe('superseded');
    const sup = await engine.listSupersessions('default');
    const old = sup.find(s => s.id === r1.id);
    expect(old).toBeDefined();
    expect(old!.expired_at).not.toBeNull();
    expect(old!.superseded_by).toBe(r2.id);
  });
});
