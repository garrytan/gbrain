/**
 * #3685: `gbrain jobs list --json` / `jobs get <id> --json` accepted the flag
 * and silently discarded it, printing the human table/detail view (exit 0,
 * no warning). The CHANGELOG explicitly directs scripts at these surfaces
 * ("For scripting, `gbrain jobs stats --json` / `gbrain jobs list --json`
 * remain the cleaner surfaces."), so a scripted consumer got a padded ASCII
 * table and a jq parse error with no signal its contract was broken.
 *
 * Pins:
 *   1. `jobs list --json` emits a parseable JSON array of jobs.
 *   2. `jobs list --json` with no jobs emits `[]` (not "No jobs found.").
 *   3. `jobs get <id> --json` emits the parseable job object.
 *   4. Help output (JOBS_HELP + cli.ts summary) advertises [--json] on
 *      list/get/stats so the CLI and the CHANGELOG agree.
 *
 * `jobs stats --json` is pinned in test/jobs-stats-divergence.serial.test.ts.
 *
 * Serial: mutates GBRAIN_HOME env via withEnv (the list/get branches consult
 * loadConfig() for thin-client routing — an empty home forces the local
 * engine path) and captures console.log around runJobs.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runJobs } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM minion_jobs`, []);
});

async function seedJob(name: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, queue, status, data, started_at, finished_at)
     VALUES ($1, 'default', 'completed', '{}'::jsonb,
             now() - interval '10 minutes', now() - interval '5 minutes')
     RETURNING id`,
    [name],
  );
  return Number(rows[0].id);
}

async function captureJobs(args: string[]): Promise<string> {
  const origLog = console.log;
  let out = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  try {
    // Empty GBRAIN_HOME (no config.json) + no DATABASE_URL → loadConfig()
    // returns null → isThinClient(null) is false → local engine path.
    await withEnv(
      { GBRAIN_HOME: emptyHome(), GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined },
      async () => { await runJobs(engine, args); },
    );
  } finally {
    console.log = origLog;
  }
  return out;
}

describe('jobs list/get --json (#3685)', () => {
  test('list --json emits a parseable JSON array of jobs', async () => {
    await seedJob('sync');
    await seedJob('autopilot-cycle');
    const out = await captureJobs(['list', '--json']);
    const doc = JSON.parse(out);
    expect(Array.isArray(doc)).toBe(true);
    expect(doc.length).toBe(2);
    const names = doc.map((j: { name: string }) => j.name).sort();
    expect(names).toEqual(['autopilot-cycle', 'sync']);
    expect(doc[0].status).toBe('completed');
    expect(typeof doc[0].id).toBe('number');
    // No human-table artifacts leak into the JSON stream.
    expect(out).not.toContain('jobs shown');
    expect(out).not.toContain('─');
  });

  test('list --json respects --status/--limit filters', async () => {
    await seedJob('sync');
    await seedJob('sync');
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, data) VALUES ('sync', 'default', 'waiting', '{}'::jsonb)`,
      [],
    );
    const out = await captureJobs(['list', '--json', '--status', 'completed', '--limit', '1']);
    const doc = JSON.parse(out);
    expect(Array.isArray(doc)).toBe(true);
    expect(doc.length).toBe(1);
    expect(doc[0].status).toBe('completed');
  });

  test('list --json with no jobs emits [] (not "No jobs found.")', async () => {
    const out = await captureJobs(['list', '--json']);
    const doc = JSON.parse(out);
    expect(doc).toEqual([]);
  });

  test('get <id> --json emits the parseable job object', async () => {
    const id = await seedJob('embed-backfill');
    const out = await captureJobs(['get', String(id), '--json']);
    const doc = JSON.parse(out);
    expect(doc.id).toBe(id);
    expect(doc.name).toBe('embed-backfill');
    expect(doc.status).toBe('completed');
    // Detail-view artifacts stay out of the JSON stream.
    expect(out).not.toContain('Job #');
  });

  test('without --json the human table still renders (no regression)', async () => {
    await seedJob('sync');
    const out = await captureJobs(['list']);
    expect(out).toContain('1 jobs shown');
    expect(() => JSON.parse(out)).toThrow();
  });
});

describe('help advertises --json on list/get/stats (#3685)', () => {
  test('JOBS_HELP usage lines carry [--json]', async () => {
    const origLog = console.log;
    let out = '';
    console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
    try {
      await runJobs(null, ['--help']);
    } finally {
      console.log = origLog;
    }
    expect(out).toContain('gbrain jobs list [--status S] [--queue Q] [--limit N] [--json]');
    expect(out).toContain('gbrain jobs get <id> [--json]');
    expect(out).toContain('gbrain jobs stats [--queue Q] [--cluster-errors] [--json]');
  });

  test('cli.ts JOBS summary lines carry [--json] (source audit)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'cli.ts'), 'utf8');
    const jobsListLine = src.split('\n').find((l) => /^\s*jobs list /.test(l));
    const jobsGetLine = src.split('\n').find((l) => /^\s*jobs get /.test(l));
    const jobsStatsLine = src.split('\n').find((l) => /^\s*jobs stats/.test(l));
    expect(jobsListLine).toContain('--json');
    expect(jobsGetLine).toContain('--json');
    expect(jobsStatsLine).toContain('--json');
  });
});
