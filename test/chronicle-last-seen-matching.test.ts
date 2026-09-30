/**
 * chronicle_last_seen matches an event's `who` entries by exact slug (or a
 * wikilink to exactly that slug), never by substring: a slug that is a prefix
 * of another slug does not inherit its sightings, and `_` in a slug is not a
 * wildcard. The newest sighting is picked by the calendar day the chronicle
 * projected (chronicle.tz local day), so a late-evening event never outranks
 * a row dated the next day. (gbrain-evals N3 temporal-asof, bugs 2 and 3.)
 *
 * Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { runChronicleExtract } from '../src/core/chronicle/extract-events.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

const op = (name: string, p: object) => {
  const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: console, dryRun: false, remote: false, sourceId: 'default' } as any;
  return operations.find(o => o.name === name)!.handler(ctx, p as any);
};
const person = (slug: string) => op('put_page', { slug, content: `---\ntype: person\ntitle: ${slug}\n---\nPerson.\n` });
async function meeting(slug: string, date: string, who: string[], when: string, tz = 'UTC') {
  await op('put_page', { slug, content: `---\ntype: meeting\ntitle: Meeting\ndate: ${date}\n---\n` + 'Notes. '.repeat(20) });
  await runChronicleExtract(engine, { slug, tz, judge: async () => ({ events: [{ when, who, what: `Meeting ${slug}`, kind: 'meeting' }] }) });
}

describe('chronicle_last_seen who matching', () => {
  test('a slug that is a prefix of another slug does not inherit its sightings', async () => {
    await person('people/kim-example');
    await person('people/kim-example-2');
    await meeting('meetings/2024-05-01-sync', '2024-05-01', ['people/kim-example-2'], '2024-05-01');
    const res = await op('chronicle_last_seen', { entity: 'people/kim-example', asof: '2024-06-01' }) as any;
    expect(res.last_date).toBeNull();
    const other = await op('chronicle_last_seen', { entity: 'people/kim-example-2', asof: '2024-06-01' }) as any;
    expect(other.last_date).toBe('2024-05-01');
  });

  test('underscore in a slug is literal, not a wildcard', async () => {
    await person('people/a_b-example');
    await meeting('meetings/2024-05-02-sync', '2024-05-02', ['people/axb-example'], '2024-05-02');
    const res = await op('chronicle_last_seen', { entity: 'people/a_b-example', asof: '2024-06-01' }) as any;
    expect(res.last_date).toBeNull();
  });

  test('a wikilink to exactly the slug still counts; a wikilink to a longer slug does not', async () => {
    await person('people/lee-example');
    await meeting('meetings/2022-09-04-sync', '2022-09-04', ['[[people/lee-example|Lee]]'], '2022-09-04');
    await meeting('meetings/2025-04-05-sync', '2025-04-05', ['[[people/lee-example-2]]'], '2025-04-05');
    const res = await op('chronicle_last_seen', { entity: 'people/lee-example', asof: '2026-06-30' }) as any;
    expect(res.last_date).toBe('2022-09-04');
  });
});

describe('chronicle_last_seen day ordering', () => {
  test('a late-evening event in a non-UTC chronicle zone does not outrank the next local day', async () => {
    await engine.setConfig('chronicle.tz', 'America/New_York');
    await person('people/dave-example');
    await meeting('meetings/2024-05-01-call', '2024-05-01', ['people/dave-example'], '2024-05-01T23:30:00-04:00', 'America/New_York');
    await op('add_timeline_entry', { slug: 'people/dave-example', date: '2024-05-02', summary: 'spoke at startup-1' });
    const res = await op('chronicle_last_seen', { entity: 'people/dave-example', asof: '2024-05-02' }) as any;
    expect(res.last_date).toBe('2024-05-02');
    expect(res.days_ago).toBe(0);
  });
});
