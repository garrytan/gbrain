/**
 * v0.31 E2E — `gbrain forget <id>` end-to-end against real Postgres.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => { if (RUN) await setupDB(); });
afterAll(async () => { if (RUN) await teardownDB(); });

d('forget_fact (Postgres)', () => {
  test('expires the fact, idempotent on re-call (returns fact_not_found)', async () => {
    const engine = getEngine();
    const inserted = await engine.insertFact(
      { fact: 'forget me', kind: 'fact', source: 'test' },
      { source_id: 'default' },
    );
    const r1 = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: false, sourceId: 'default',
    });
    expect(r1.isError).toBeFalsy();
    const payload1 = JSON.parse(r1.content[0].text);
    expect(payload1.expired).toBe(true);

    const r2 = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: false, sourceId: 'default',
    });
    expect(r2.isError).toBe(true);
    const payload2 = JSON.parse(r2.content[0].text);
    expect(payload2.error).toBe('fact_not_found');
  });

  test('expired facts disappear from active recall but show under --include-expired', async () => {
    const engine = getEngine();
    const r = await engine.insertFact(
      { fact: 'will hide', kind: 'fact', entity_slug: 'forget-test', source: 'test' },
      { source_id: 'default' },
    );
    await engine.expireFact(r.id);

    const active = await engine.listFactsByEntity('default', 'forget-test');
    expect(active.length).toBe(0);
    const all = await engine.listFactsByEntity('default', 'forget-test', { activeOnly: false });
    expect(all.find(f => f.id === r.id)).toBeDefined();
  });
});
