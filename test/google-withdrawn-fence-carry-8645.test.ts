/**
 * #8645: an unmanaged Google connector page whose checkout file lacks only gbrain's own `## Facts` fence is
 * replaceable (#7292), but once one of that fence's facts was forgotten the re-render was refused
 * file_database_drift on every run and held after three. The guard compared the file plus the live page's fence,
 * which carries the withdrawal overlay, against the raw stored body, which does not. Now each stored state is compared
 * with the file plus that state's own fence; a real file edit is still held. The file holds the provider render from
 * before the facts, and the page carries more than 20 of them, so that render is no longer among the retained versions
 * the guard also compares.
 * Real PGLite and Postgres (when DATABASE_URL is set), the real Google importer, a fake People API.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, readGoogleState, runGoogleSync } from '../src/core/google/google-source.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { FACTS_FENCE_BEGIN } from '../src/core/facts-fence.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { contact, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'source-a';
const SLUG = 'people/alice-example';
const KEPT = 'Alice will send the signed deck by Friday';
const FORGOTTEN = 'Alice moved to the acme-example design team';
const CONFIG = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'contacts', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };

async function withBrain(databaseUrl: string | undefined, run: (b: { engine: BrainEngine; root: string; path: string; render: string; bump(): void; sync(): ReturnType<typeof runGoogleSync> }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-8645-'));
  try {
    await withEnv({ GBRAIN_HOME: root, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        const dir = join(root, 'google');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [SOURCE, dir, JSON.stringify(CONFIG)]);
        let generation = 0;
        const fetch = withGoogleAccount(async (url: string) => {
          if (new URL(url).pathname === '/v1/people/me/connections') return json({ connections: [
            { ...contact('c1', 'Alice Example'), organizations: [{ name: `Upstream ${generation}` }] }], nextSyncToken: `token-${generation}` });
          throw new Error(`Unexpected Google fixture route: ${url}`);
        }, CONFIG.g_account);
        const cfg = parseGoogleSourceConfig(CONFIG, dir);
        const sync = () => runGoogleSync(engine, SOURCE, cfg, { ...options, sourceId: SOURCE }, fetch);
        expect((await sync()).failedFiles ?? 0).toBe(0);
        const path = join(dir, `${SLUG}.md`);
        await run({ engine, root, path, render: readFileSync(path, 'utf8'), bump: () => { generation++; }, sync });
      } finally { await close(); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const holds = (root: string) => ((readGoogleState(join(root, 'google')).item_holds ?? { items: {} }) as { items: Record<string, { code: string; state: string }> }).items;

async function rememberAndForget(engine: BrainEngine): Promise<void> {
  const others = Array.from({ length: 20 }, (_, i) => `Alice example note ${i + 1}`);
  for (const fact of [KEPT, ...others, FORGOTTEN]) {
    await writeSingleFact(engine, SOURCE, { fact, kind: 'fact', entity: 'Alice Example', visibility: 'private', provenance: 'email thread (synthetic)', remote: false });
  }
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND fact=$2', [SOURCE, FORGOTTEN]);
  expect((await recordFactWithdrawal(engine, Number(row!.id), SOURCE)).withdrawn).toBe(true);
  const raw = (await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, SLUG]))[0]!.compiled_truth;
  const live = (await engine.getPage(SLUG, { sourceId: SOURCE }))!.compiled_truth;
  expect(raw).toContain(FORGOTTEN);
  expect(live).not.toBe(raw);
}

for (const backend of testBackends()) describe(`[${backend}] #8645: a forgotten fact on an unmanaged Google connector page`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a file that lacks only the fence re-renders instead of being held, and the withdrawal stays', async () => withBrain(databaseUrl, async b => {
    await rememberAndForget(b.engine);
    writeFileSync(b.path, b.render);
    expect(b.render).not.toContain(FACTS_FENCE_BEGIN);
    b.bump();
    for (let i = 0; i < 3; i++) expect((await b.sync()).failedFiles ?? 0).toBe(0);
    expect(holds(b.root)['contact:people/c1']).toBeUndefined();
    const file = readFileSync(b.path, 'utf8');
    expect(file).toContain('Upstream 1');
    expect(file).toContain(KEPT);
    const active = await b.engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY fact', [SOURCE]);
    expect(active.map(r => r.fact)).not.toContain(FORGOTTEN);
    expect(active.map(r => r.fact)).toContain(KEPT);
  }), 180_000);

  test('a real file edit next to the missing fence is still held', async () => withBrain(databaseUrl, async b => {
    await rememberAndForget(b.engine);
    writeFileSync(b.path, `${b.render}\nFILE-ONLY-EDIT: kept by the user.\n`);
    b.bump();
    for (let i = 0; i < 3; i++) expect((await b.sync()).failedFiles).toBe(1);
    expect(holds(b.root)['contact:people/c1']).toMatchObject({ code: 'file_database_drift', state: 'held' });
    expect(readFileSync(b.path, 'utf8')).toContain('FILE-ONLY-EDIT');
  }), 180_000);
});
