/**
 * v0.31 E2E — cross-source isolation against real Postgres.
 *
 * Two sources, same entity_slug, no leak.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => {
  if (!RUN) return;
  const engine = await setupDB();
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('alpha', 'Alpha', '{}'::jsonb) ON CONFLICT DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('beta',  'Beta',  '{}'::jsonb) ON CONFLICT DO NOTHING`);
});
afterAll(async () => { if (RUN) await teardownDB(); });

d('facts cross-source isolation (Postgres)', () => {
  test('listFactsByEntity scopes by source_id', async () => {
    const engine = getEngine();
    await engine.insertFact(
      { fact: 'alpha alice', kind: 'fact', entity_slug: 'people/alice-example', source: 'test' },
      { source_id: 'alpha' },
    );
    await engine.insertFact(
      { fact: 'beta alice', kind: 'fact', entity_slug: 'people/alice-example', source: 'test' },
      { source_id: 'beta' },
    );

    const a = await engine.listFactsByEntity('alpha', 'people/alice-example');
    const b = await engine.listFactsByEntity('beta', 'people/alice-example');

    expect(a.every(r => r.source_id === 'alpha')).toBe(true);
    expect(b.every(r => r.source_id === 'beta')).toBe(true);
    expect(a.find(r => r.fact === 'beta alice')).toBeUndefined();
    expect(b.find(r => r.fact === 'alpha alice')).toBeUndefined();
  });

  test('CASCADE on sources delete drops the source\'s facts', async () => {
    const engine = getEngine();
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('eph-pg', 'Eph PG', '{}'::jsonb)`);
    await engine.insertFact(
      { fact: 'eph fact', kind: 'fact', source: 'test' },
      { source_id: 'eph-pg' },
    );
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'eph-pg'`);
    const remaining = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM facts WHERE source_id = 'eph-pg'`,
    );
    expect(Number(remaining[0].count)).toBe(0);
  });
});
