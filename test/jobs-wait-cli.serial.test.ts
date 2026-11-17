/**
 * #7242 `foresights jobs wait` exit codes (0 completed, 1 failed/dead/cancelled, 124 still running, 2 usage) and the
 * #7241 fields in `jobs get --json` / `jobs list --json` / `jobs list --finished-since`.
 *
 * Serial: patches console and process.exit around runJobs and sets GBRAIN_HOME via withEnv
 * (an empty home forces the local engine path), like jobs-list-get-json.serial.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
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
  await engine.executeRaw('DELETE FROM minion_jobs');
});

async function seed(status: string, extra = ''): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, error_text, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'noop', 'default', $1, '{"__submitter":"cli:test"}'::jsonb, $2,
             CASE WHEN $1 IN ('completed','failed','dead','cancelled') THEN now() END)
     RETURNING id`, [status, extra || null]);
  return Number(rows[0].id);
}

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const origLog = console.log, origErr = console.error, origExit = process.exit;
  let out = '', err = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  process.exit = ((code?: number) => { throw new Exit(code ?? 0); }) as typeof process.exit;
  let code = 0;
  try {
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined },
      async () => { await runJobs(engine, args); });
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    console.log = origLog; console.error = origErr; process.exit = origExit;
  }
  return { code, out, err };
}

describe('jobs wait', () => {
  test('a completed job exits 0 and prints the row with the #7241 fields', async () => {
    const id = await seed('completed');
    const r = await run(['wait', String(id), '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({ id, status: 'completed', submitted_by: { kind: 'local', via: 'cli:test' }, blocked_by: null,
      spend: { cost_usd: null, cost_basis: 'unpriced' } });
  });

  test('failed, dead and cancelled exit 1 and say how the job ended', async () => {
    for (const status of ['failed', 'dead', 'cancelled']) {
      const id = await seed(status, 'boom-example');
      const r = await run(['wait', String(id)]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`ended ${status}`);
    }
  });

  test('the timeout exits 124 (still running, not a failure) and leaves the job alone', async () => {
    const id = await seed('waiting');
    const started = Date.now();
    const r = await run(['wait', String(id), '--timeout', '1s', '--json']);
    expect(r.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(JSON.parse(r.out)).toMatchObject({ id, status: 'waiting' });
    expect(r.err).toContain('still waiting');
    expect(r.err).toContain(`foresights jobs wait ${id}`);
    const [row] = await engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id = $1', [id]);
    expect(row.status).toBe('waiting');
  });

  test('usage errors exit 2; a missing job exits 1', async () => {
    expect((await run(['wait'])).code).toBe(2);
    expect((await run(['wait', '7', '--timeout', 'soon'])).code).toBe(2);
    const missing = await run(['wait', '999999', '--timeout', '1s']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not found');
  });
});

describe('jobs get / list carry the #7241 fields', () => {
  test('get --json and list --json include blocked_by and spend; the table has a wait column', async () => {
    const a = await seed('waiting');
    const b = await seed('waiting');
    const get = JSON.parse((await run(['get', String(b), '--json'])).out);
    expect(get.blocked_by[0]).toMatchObject({ kind: 'queue', queue_position: 2, ahead: 1 });
    const list = JSON.parse((await run(['list', '--json'])).out) as Array<Record<string, any>>;
    expect(list.find(j => j.id === a)!.blocked_by[0]).toMatchObject({ queue_position: 1 });
    const table = (await run(['list'])).out;
    expect(table).toContain('Wait/Live');
    expect(table).toContain('#2 (0 run)');
  });

  test('list --finished-since pages terminal events with a cursor', async () => {
    await seed('waiting');
    const done = await seed('completed');
    const page = JSON.parse((await run(['list', '--finished-since', '2000-01-01T00:00:00Z', '--json'])).out);
    expect(page.jobs.map((j: { id: number }) => j.id)).toEqual([done]);
    expect(page.next_cursor).toMatch(/^\d+:\d+$/);
    const next = JSON.parse((await run(['list', '--finished-since', page.next_cursor, '--json'])).out);
    expect(next.jobs).toEqual([]);
    expect((await run(['list', '--finished-since', 'later'])).code).toBe(2);
  });
});
