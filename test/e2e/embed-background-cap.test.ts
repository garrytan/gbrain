/**
 * Fix wave 13 P1.18 [R4]: `gbrain embed --background --max-usd N` carries the
 * approval to the worker. The queued `embed` row stores the spend
 * authorization with the approved cap (the worker's runWithJobSpend meters
 * every provider call against it); a run with no authorization (a free
 * provider) queues no authorization, as before.
 * Seams: none; Postgres only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runEmbed } from '../../src/commands/embed.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
let engine: PostgresEngine;

beforeAll(async () => { if (RUN) engine = await setupDB() as PostgresEngine; }, 120_000);
afterAll(async () => { if (RUN) await teardownDB(); });

async function queued(sourceId: string) {
  const rows = await engine.executeRaw<{ spend_authorization: Record<string, unknown> | string | null }>(
    `SELECT spend_authorization FROM minion_jobs WHERE name = 'embed' AND data->>'sourceId' = $1 ORDER BY id DESC LIMIT 1`, [sourceId]);
  const raw = rows[0]?.spend_authorization ?? null;
  return typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw;
}

d('embed --background carries the approved cap', () => {
  test('the queued row stores the authorization with cap_usd', async () => {
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await runEmbed(engine, ['--stale', '--source', 'cap-src', '--max-usd', '0.25', '--background'], null,
        { authorization: { consented_effects: ['paid'], cap_usd: 0.25, cap_source: 'user', via: 'max_usd' } });
      await runEmbed(engine, ['--stale', '--source', 'free-src', '--background'], null, { authorization: null });
    } finally { process.stdout.write = write; }
    expect(await queued('cap-src')).toMatchObject({ kind: 'authorized', cap_usd: 0.25, cap_source: 'user', command: 'embed' });
    expect(await queued('free-src')).toBeNull();
  });
});
