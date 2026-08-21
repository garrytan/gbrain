/**
 * E2E — listFactsSince `eventTime` option against real Postgres (parity gate).
 *
 * Mirrors the `listFactsSince eventTime option` describe block in
 * test/facts-engine.test.ts (PGLite). Skips gracefully when DATABASE_URL
 * is unset.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => { if (RUN) await setupDB(); });
afterAll(async () => { if (RUN) await teardownDB(); });

d('listFactsSince eventTime option (Postgres)', () => {
  test('default (eventTime unset) filters/orders by created_at, ignoring valid_from', async () => {
    const engine = getEngine();
    const slug = `evt-default-pg-${Math.random().toString(36).slice(2, 8)}`;
    const eventOld = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // event: 10 days ago
    const eventRecent = new Date(Date.now() - 60 * 60 * 1000); // event: 1 hour ago
    await engine.insertFact(
      { fact: `${slug} old-event`, kind: 'fact', entity_slug: slug, source: 'test', valid_from: eventOld },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: `${slug} recent-event`, kind: 'fact', entity_slug: slug, source: 'test', valid_from: eventRecent },
      { source_id: 'default' },
    );
    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const rows = await engine.listFactsSince('default', since48h, { entitySlug: slug });
    expect(rows.length).toBe(2);
  });

  test('eventTime:true filters by valid_from — a backdated event drops out of a 48h window', async () => {
    const engine = getEngine();
    const slug = `evt-filter-pg-${Math.random().toString(36).slice(2, 8)}`;
    const eventOld = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const eventRecent = new Date(Date.now() - 60 * 60 * 1000);
    await engine.insertFact(
      { fact: `${slug} old-event`, kind: 'fact', entity_slug: slug, source: 'test', valid_from: eventOld },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: `${slug} recent-event`, kind: 'fact', entity_slug: slug, source: 'test', valid_from: eventRecent },
      { source_id: 'default' },
    );
    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const rows = await engine.listFactsSince('default', since48h, { entitySlug: slug, eventTime: true });
    expect(rows.length).toBe(1);
    expect(rows[0].fact).toBe(`${slug} recent-event`);
  });

  test('eventTime:true orders by valid_from DESC instead of created_at DESC', async () => {
    const engine = getEngine();
    const slug = `evt-order-pg-${Math.random().toString(36).slice(2, 8)}`;
    const laterEvent = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const earlierEvent = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5h ago
    await engine.insertFact(
      {
        fact: `${slug} later-event-inserted-first`,
        kind: 'fact',
        entity_slug: slug,
        source: 'test',
        valid_from: laterEvent,
      },
      { source_id: 'default' },
    );
    await engine.insertFact(
      {
        fact: `${slug} earlier-event-inserted-second`,
        kind: 'fact',
        entity_slug: slug,
        source: 'test',
        valid_from: earlierEvent,
      },
      { source_id: 'default' },
    );
    const since = new Date(0);
    const byCreated = await engine.listFactsSince('default', since, { entitySlug: slug });
    const byEvent = await engine.listFactsSince('default', since, { entitySlug: slug, eventTime: true });
    expect(byCreated.length).toBe(2);
    expect(byEvent.length).toBe(2);
    expect(byCreated[0].fact).toBe(`${slug} earlier-event-inserted-second`);
    expect(byEvent[0].fact).toBe(`${slug} later-event-inserted-first`);
  });
});
