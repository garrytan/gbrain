/** A moved calendar page is retired only after its replacement actually lands. */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { EnvAccessProvider } from '../src/core/google/access.ts';
import { CalendarClient } from '../src/core/google/google-clients.ts';
import { parseGoogleSourceConfig, readGoogleState } from '../src/core/google/google-source.ts';
import { calendarRelPath } from '../src/core/google/google-render.ts';
import { sweepCalendar } from '../src/core/google/people-calendar-sweep.ts';
import type { GoogleSyncDeps, GoogleSyncSummary } from '../src/core/google/sweep-shared.ts';
import type { CalendarEventData } from '../src/core/google/types.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const SOURCE = 'calendar-test';
const ACCOUNT = 'owner@example.invalid';

async function fixture(run: (f: {
  dir: string;
  setTitle(title: string): string;
  sweep(): Promise<void>;
}) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-calendar-replacement-'));
  const dir = join(home, 'source');
  mkdirSync(dir);
  try {
    await withEnv({ GBRAIN_HOME: home, CALENDAR_TEST_TOKEN: 'synthetic-test-token', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const config = { kind: 'google', g_account: ACCOUNT, g_services: 'calendar', g_access: 'env', g_token_env: 'CALENDAR_TEST_TOKEN' };
      await engine.executeRaw('INSERT INTO sources (id,name,local_path,config) VALUES ($1,$1,$2,$3::text::jsonb)', [SOURCE, dir, JSON.stringify(config)]);
      const cfg = parseGoogleSourceConfig(config, dir);
      const start = new Date(Date.now() + 86_400_000).toISOString();
      const end = new Date(Date.parse(start) + 3_600_000).toISOString();
      let title = 'Original meeting';
      const setTitle = (next: string) => {
        title = next;
        return calendarRelPath({ id: 'event12345', startIso: start, summary: title } as CalendarEventData);
      };
      const client = new CalendarClient(new EnvAccessProvider('CALENDAR_TEST_TOKEN'), async () => new Response(JSON.stringify({
        items: [{ id: 'event12345', status: 'confirmed', summary: title, start: { dateTime: start }, end: { dateTime: end },
          organizer: { email: ACCOUNT }, attendees: [{ email: ACCOUNT, self: true, responseStatus: 'accepted' }] }],
        nextSyncToken: 'next-token',
      }), { headers: { 'content-type': 'application/json' } }));
      const deps = { engine, sourceId: SOURCE, cfg, managed: null, opts: {}, log() {}, tick() {} } as unknown as GoogleSyncDeps;
      const summary = { status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0,
        pagesAffected: [], threadsSeen: 0, attachmentInspection: {}, extractEligibility: {}, loopsWithheld: {}, failedFiles: 0 } as GoogleSyncSummary;
      const state = readGoogleState(dir);
      await run({ dir, setTitle, sweep: () => sweepCalendar(deps, client, state, undefined, summary, new Set()) });
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('a failed replacement leaves the original page and file, then a retry moves it', async () => {
  await fixture(async ({ dir, setTitle, sweep }) => {
    const original = setTitle('Original meeting');
    await sweep();
    const oldSlug = slugifyPath(original);
    expect(await engine.getPage(oldSlug, { sourceId: SOURCE })).not.toBeNull();
    expect(existsSync(join(dir, original))).toBe(true);

    const replacement = setTitle('Renamed meeting');
    const blockedTemp = join(dir, `${replacement}.tmp`);
    mkdirSync(blockedTemp, { recursive: true });
    await expect(sweep()).rejects.toThrow('Stale temporary path');
    expect(await engine.getPage(oldSlug, { sourceId: SOURCE })).not.toBeNull();
    expect(existsSync(join(dir, original))).toBe(true);
    expect(await engine.getPage(slugifyPath(replacement), { sourceId: SOURCE })).toBeNull();

    rmSync(blockedTemp, { recursive: true });
    await sweep();
    expect(await engine.getPage(oldSlug, { sourceId: SOURCE })).toBeNull();
    expect(existsSync(join(dir, original))).toBe(false);
    expect(await engine.getPage(slugifyPath(replacement), { sourceId: SOURCE })).not.toBeNull();
    expect(existsSync(join(dir, replacement))).toBe(true);
  });
}, 120_000);

test('a purged replacement is skipped without removing the existing event', async () => {
  await fixture(async ({ dir, setTitle, sweep }) => {
    const purged = setTitle('Purged meeting');
    await sweep();
    const purgedSlug = slugifyPath(purged);
    const snapshot = (await engine.readPageSnapshot(purgedSlug, { sourceId: SOURCE }))!;
    const ctx = { engine, sourceId: SOURCE, config: { engine: engine.kind }, remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } };
    await submitPageMutation(ctx as never, { operation: 'delete_page', params: { slug: purgedSlug, purge: true, expected_revision: snapshot.revision } });
    expect(await engine.getPage(purgedSlug, { sourceId: SOURCE })).toBeNull();

    const original = setTitle('Original meeting');
    await sweep();
    const oldSlug = slugifyPath(original);
    expect(await engine.getPage(oldSlug, { sourceId: SOURCE })).not.toBeNull();
    setTitle('Purged meeting');
    await sweep();
    expect(await engine.getPage(oldSlug, { sourceId: SOURCE })).not.toBeNull();
    expect(existsSync(join(dir, original))).toBe(true);
    expect(await engine.getPage(purgedSlug, { sourceId: SOURCE })).toBeNull();
  });
}, 120_000);
