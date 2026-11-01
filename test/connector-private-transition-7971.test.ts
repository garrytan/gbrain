/**
 * #7971 item 1: on a managed, Git-bound connector source that is strict (canonical: git), a page that turns private
 * leaves Git. A managed Google calendar sweep commits a world event's page through the door; when Google later marks the
 * event private, the next sweep publishes the commit that removes its file (G7a's private transition), so the file is
 * gone from HEAD and the working tree, the row is private and database-only, and the private text appears in no commit.
 * An event that was private from the start still writes no file, before and after. Before the fix the connector path
 * published the turning-private page database-only and left its public file committed at HEAD.
 * PGLite here; Postgres in test/e2e/connector-private-transition-7971-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { completeBaselineSweep, googleConfig, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { initStrictCheckout, strictSource } from './helpers/strict-door-census.ts';

const config = { ...googleConfig, g_services: 'calendar' };
const PRIVATE_MARKER = 'turnedprivatemarkeracmeexample';
const at = Date.parse('2026-10-20T17:00:00Z');
const event = (id: string, summary: string, extra: Record<string, unknown> = {}) => ({ id, summary, status: 'confirmed',
  start: { dateTime: new Date(at).toISOString() }, end: { dateTime: new Date(at + 3_600_000).toISOString() }, ...extra });

interface Row { slug: string; source_path: string | null; withheld_source_path: string | null; reason: string | null; visibility: string | null }
const calendarRows = (engine: BrainEngine) => engine.executeRaw<Row>(
  `SELECT slug, source_path, withheld_source_path, database_only_reason AS reason, frontmatter->>'visibility' AS visibility
     FROM pages WHERE source_id='default' AND slug LIKE 'calendar/%' AND deleted_at IS NULL ORDER BY slug`);
const atHead = (root: string, path: string) => git(root, 'ls-tree', '--name-only', 'HEAD', '--', path).trim();

for (const backend of testBackends()) describe(`[${backend}] #7971: a connector page turning private on a strict Git-bound source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('the public file leaves HEAD in the transition commit; no private text is committed; an always-private page writes no file', () => withEnv({ CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' }, () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    let events = [
      event('turning-event-a', 'Acme example planning', { updated: '2026-10-19T00:00:00Z' }),
      event('private-event-b', 'Bob example offsite', { visibility: 'private', updated: '2026-10-19T00:00:00Z' }),
    ];
    const calendarFetch = withGoogleAccount(async (url: string) => {
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      if (url.includes('/calendar/')) return json({ items: events, nextSyncToken: 'calendar-7971' });
      throw new Error('Unexpected external fixture route');
    });
    const run = () => runGoogleSync(engine, 'default', parseGoogleSourceConfig(config, root), options, calendarFetch);
    await completeBaselineSweep(engine, 'default', run);

    const first = await calendarRows(engine);
    expect(first).toHaveLength(2);
    const turning = first.find(row => row.slug.includes('acme-example-planning'))!;
    const alwaysPrivate = first.find(row => row.slug.includes('bob-example-offsite'))!;
    expect(turning.visibility).toBeNull();
    expect(turning.source_path).toBeTruthy();
    const path = turning.source_path!;
    expect(atHead(root, path)).toBe(path);
    expect(alwaysPrivate).toMatchObject({ visibility: 'private', source_path: null, reason: 'private' });
    expect(existsSync(join(root, `${alwaysPrivate.slug}.md`))).toBe(false);
    expect(atHead(root, `${alwaysPrivate.slug}.md`)).toBe('');

    events = [
      event('turning-event-a', 'Acme example planning', { visibility: 'private', description: `Agenda ${PRIVATE_MARKER} notes`, updated: '2026-10-21T00:00:00Z' }),
      event('private-event-b', 'Bob example offsite', { visibility: 'private', updated: '2026-10-19T00:00:00Z' }),
    ];
    await completeBaselineSweep(engine, 'default', run);

    const after = await calendarRows(engine);
    expect(after.map(row => row.slug)).toEqual(first.map(row => row.slug));
    expect(after.find(row => row.slug === turning.slug)).toMatchObject({ visibility: 'private', source_path: null, withheld_source_path: path, reason: 'private' });
    expect(atHead(root, path)).toBe('');
    expect(existsSync(join(root, path))).toBe(false);
    expect(git(root, 'log', '-p', '--all', '--format=%H %s').includes(PRIVATE_MARKER)).toBe(false);
    expect(git(root, 'log', '--diff-filter=D', '--name-only', '--format=', '--', path).trim()).toBe(path);
    expect(after.find(row => row.slug === alwaysPrivate.slug)).toMatchObject({ visibility: 'private', source_path: null, reason: 'private' });
    expect(existsSync(join(root, `${alwaysPrivate.slug}.md`))).toBe(false);
    expect(git(root, 'log', '--all', '--name-only', '--format=').includes(alwaysPrivate.slug)).toBe(false);
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');

    // A changed re-render of the now-private page (its removed path kept as withheld_source_path) stays database-only.
    const headBefore = git(root, 'rev-parse', 'HEAD').trim();
    events = [
      event('turning-event-a', 'Acme example planning', { visibility: 'private', description: `Agenda ${PRIVATE_MARKER} revised`, updated: '2026-10-22T00:00:00Z' }),
      event('private-event-b', 'Bob example offsite', { visibility: 'private', description: `Offsite ${PRIVATE_MARKER} plan`, updated: '2026-10-22T00:00:00Z' }),
    ];
    await completeBaselineSweep(engine, 'default', run);
    const [rerendered] = await engine.executeRaw<{ body: string }>("SELECT compiled_truth AS body FROM pages WHERE source_id='default' AND slug=$1", [turning.slug]);
    expect(rerendered!.body).toContain(`${PRIVATE_MARKER} revised`);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(atHead(root, path)).toBe('');
    expect(existsSync(join(root, path))).toBe(false);
    expect(existsSync(join(root, `${alwaysPrivate.slug}.md`))).toBe(false);
    expect(git(root, 'log', '-p', '--all', '--format=%H %s').includes(PRIVATE_MARKER)).toBe(false);
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  }, { databaseUrl, setup: async ({ engine, root }) => {
    initStrictCheckout(root);
    await engine.executeRaw("UPDATE sources SET config=$1::text::jsonb WHERE id='default'", [JSON.stringify(config)]);
  } })), 180_000);
});
