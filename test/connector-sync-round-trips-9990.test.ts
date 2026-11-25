/**
 * #9990: the database statements a managed connector sweep spends per contact, on PGLite.
 *
 * Far from its database (a Supabase pooler), a connector sweep's speed is its round trips per item. One call (a page
 * read, an import) re-read the run's lease, source row, owner binding, writer grant and the source's mirror and
 * slug-root modes up to nine times each. An unchanged
 * contact cost about 52 statements, so a re-run that only re-checked contacts it had already written took about
 * 1.5 s per contact at 30 ms, and a first sync whose page of 200 contacts did not commit in one run started that page
 * again next run.
 *
 * Protects: two numbers, statement counts (deterministic, unlike timings): the extra statements an unchanged re-run and
 * a first sync spend per extra contact, measured as the difference between an 18-contact and a 6-contact source so
 * fixed run costs cancel. Measured after the fix: about 40 per unchanged contact (52 before) and 187 per first write
 * (190 before). The unchanged budget is about 10% over its measurement and well under the old count.
 * Fails when: a run-wide read starts going to the database more than once per connector call again.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { countPgliteStatements } from './helpers/statement-counter.ts';
import { completeBaselineSweep, contact, createConnectorFixture, googleConfig, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';

const UNCHANGED_PER_CONTACT_BUDGET = 44;
const FIRST_WRITE_PER_CONTACT_BUDGET = 199;
const SMALL = 6;
const LARGE = 18;

const { engines, env, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

/** A bound contacts source of `total` contacts: the statements of its first sync (until settled) and of one unchanged re-run. */
async function sweepStatements(engine: PGLiteEngine, total: number) {
  const f = await boundSource(engine, googleConfig);
  const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
  const fetcher = async (url: string) => {
    if (!new URL(url).pathname.endsWith('/people/me/connections')) return json({ error: { message: 'unexpected fixture route' } }, 400);
    return json({ connections: Array.from({ length: total }, (_, i) => contact(`c${i}`, `Person ${i} Example`)), nextSyncToken: 'ppl-1' });
  };
  const run = () => runGoogleSync(engine, f.id, cfg, { ...options }, withGoogleAccount(fetcher, cfg.account));
  let counter = countPgliteStatements(engine);
  await completeBaselineSweep(engine, f.id, run);
  const first = counter.stop().length;
  const [pages] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug LIKE 'people/%'", [f.id]);
  expect(pages!.n).toBe(total);
  counter = countPgliteStatements(engine);
  const again = await run();
  expect(again.status).toBe('up_to_date');
  return { first, again: counter.stop().length };
}

test('#9990: a managed contacts sweep reads each run-wide row once per call, so an unchanged contact costs about 40 statements', async () => withEnv(env, async () => {
  const engine = engines.find(e => e.kind === 'pglite') as PGLiteEngine | undefined;
  if (!engine) return;
  const small = await sweepStatements(engine, SMALL);
  const large = await sweepStatements(engine, LARGE);
  const unchanged = (large.again - small.again) / (LARGE - SMALL);
  const firstWrite = (large.first - small.first) / (LARGE - SMALL);
  expect(unchanged).toBeLessThanOrEqual(UNCHANGED_PER_CONTACT_BUDGET);
  expect(firstWrite).toBeLessThanOrEqual(FIRST_WRITE_PER_CONTACT_BUDGET);
}), 240_000);
