/**
 * G6 (git-canonical memory): a managed Google calendar sweep on a strict (canonical: git) source never commits a private
 * event. Private pages are a declared database-only class (docs/designs/GIT_CANONICAL_MEMORY.md): the event marked
 * `visibility: private` (or confidential) by Google publishes database-only, so its text appears in no commit, while the
 * world events of the same sweep are committed at HEAD through the door. A second sweep re-renders the same events and
 * still commits nothing private.
 * PGLite here; Postgres in test/e2e/g6-calendar-private-strict-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { completeBaselineSweep, googleConfig, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { describeMeasure, expectDoorOnly, head, initStrictCheckout, measureBatch, strictSource } from './helpers/strict-door-census.ts';

const config = { ...googleConfig, g_services: 'calendar' };
const PRIVATE_MARKER = 'privatemarkeracmeexample';
const at = Date.parse('2026-10-20T17:00:00Z');
const event = (id: string, summary: string, extra: Record<string, unknown> = {}) => ({ id, summary, status: 'confirmed',
  start: { dateTime: new Date(at).toISOString() }, end: { dateTime: new Date(at + 3_600_000).toISOString() }, ...extra });
const events = [
  event('world-event-a', 'Acme example planning'),
  event('world-event-b', 'Bob example sync'),
  event('private-event-c', `Alice example ${PRIVATE_MARKER}`, { visibility: 'private', description: `Agenda ${PRIVATE_MARKER} notes` }),
];
const calendarFetch = withGoogleAccount(async (url: string) => {
  if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
  if (url.includes('/calendar/')) return json({ items: events, nextSyncToken: 'calendar-g6' });
  throw new Error('Unexpected external fixture route');
});

for (const backend of testBackends()) describe(`[${backend}] G6: a private calendar event on a strict source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('the private event stays database-only and out of git history; the world events are committed', () => withEnv({ CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' }, () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    const base = head(root);
    const run = () => runGoogleSync(engine, 'default', parseGoogleSourceConfig(config, root), options, calendarFetch);
    await completeBaselineSweep(engine, 'default', run);
    await run();
    const rows = await engine.executeRaw<{ slug: string; source_path: string | null; visibility: string | null }>(
      "SELECT slug, source_path, frontmatter->>'visibility' AS visibility FROM pages WHERE source_id='default' AND slug LIKE 'calendar/%' AND deleted_at IS NULL ORDER BY slug");
    const priv = rows.filter(row => row.visibility === 'private');
    const world = rows.filter(row => row.visibility !== 'private');
    expect(priv).toHaveLength(1);
    expect(priv[0]!.slug).toContain(PRIVATE_MARKER);
    expect(world).toHaveLength(2);
    const history = git(root, 'log', '-p', '--all', '--format=%H %s');
    const m = await measureBatch(engine, 'default', root, base, world.map(row => row.slug));
    console.log(describeMeasure(`calendar-private/${backend}`, m) + ` declared=${JSON.stringify(m.census.declared)} declared_with_head_blob=${m.census.declared_with_head_blob}`);
    expect(history.includes(PRIVATE_MARKER)).toBe(false);
    expect(existsSync(join(root, priv[0]!.source_path ?? `${priv[0]!.slug}.md`))).toBe(false);
    expect(m.census.declared.private).toBe(1);
    expect(m.census.declared_with_head_blob).toBe(0);
    expectDoorOnly(m, expect);
  }, { databaseUrl, setup: async ({ engine, root }) => {
    initStrictCheckout(root);
    await engine.executeRaw("UPDATE sources SET config=$1::text::jsonb WHERE id='default'", [JSON.stringify(config)]);
  } })), 120_000);
});
