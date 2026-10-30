/**
 * #7292 (GBRA-133): facts that loop extraction (or `remember`) writes into the `## Facts` fence of an unmanaged Google
 * connector page. The managed connector carries brain-added fences into each re-render; the unmanaged one replaced the
 * page with the bare provider render, so the fence left the file and the database and the next `extract_facts` expired
 * the facts. And a page whose database body holds the fence while its checkout file does not was refused
 * `file_database_drift` on every re-render and frozen held after three, with no command that could unfreeze it. Now the
 * unmanaged re-render carries the stored fence, a file that lacks only gbrain's own fence is replaceable (the carried
 * render writes the fence back), and a held page imports on its next attempt (`gbrain sources retry-held`). A real file
 * edit is still held. Real PGLite and Postgres (when DATABASE_URL is set), the real Google importer, a fake People API.
 * Contributed report: @h6y3.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, readGoogleState, runGoogleSync } from '../src/core/google/google-source.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { FACTS_FENCE_BEGIN, stripFactsFence } from '../src/core/facts-fence.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { runRetryHeld } from '../src/commands/sources-retry-held.ts';
import { contact, json, options, withGoogleAccount } from './helpers/connector-fixture.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'google-example';
const SLUG = 'people/alice-example';
const CLAIM = 'Alice will send the signed deck by Friday';
const CONFIG = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'contacts', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };

interface Brain { engine: BrainEngine; root: string; path: string; file(): string; body(): Promise<string>; bump(): void; sync(): ReturnType<typeof runGoogleSync>;
  remember(): Promise<void>; activeFacts(): Promise<number> }

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-7292-'));
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
            { ...contact('c1', 'Alice Example'), organizations: [{ name: `Upstream ${generation}` }] },
            { ...contact('c2', 'Bob Example'), organizations: [{ name: `Upstream ${generation}` }] }], nextSyncToken: `token-${generation}` });
          throw new Error(`Unexpected Google fixture route: ${url}`);
        }, CONFIG.g_account);
        const cfg = parseGoogleSourceConfig(CONFIG, dir);
        const sync = () => runGoogleSync(engine, SOURCE, cfg, { ...options, sourceId: SOURCE }, fetch);
        expect((await sync()).failedFiles ?? 0).toBe(0);
        const path = join(dir, `${SLUG}.md`);
        await run({ engine, root, path, file: () => readFileSync(path, 'utf8'), bump: () => { generation++; }, sync,
          body: async () => (await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, SLUG]))[0]!.compiled_truth,
          remember: async () => { await writeSingleFact(engine, SOURCE, { fact: CLAIM, kind: 'commitment', entity: 'Alice Example', visibility: 'private', provenance: 'email thread (synthetic)', remote: false }); },
          activeFacts: async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL', [SOURCE, CLAIM]))[0]!.n) });
      } finally { await close(); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const holds = (root: string) => ((readGoogleState(join(root, 'google')).item_holds ?? { items: {} }) as { items: Record<string, { code: string; state: string }> }).items;

for (const backend of testBackends()) describe(`[${backend}] #7292: brain-added facts on an unmanaged Google connector page`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a re-render carries the fence into the file and the database, and extract_facts keeps the fact', async () => withBrain(databaseUrl, async b => {
    await b.remember();
    expect(b.file()).toContain(CLAIM);
    b.bump();
    const result = await b.sync();
    expect(result.failedFiles ?? 0).toBe(0);
    expect(b.file()).toContain('Upstream 1');
    expect(b.file()).toContain(CLAIM);
    expect(await b.body()).toContain(CLAIM);
    await runExtractFacts(b.engine, { sourceId: SOURCE });
    expect(await b.activeFacts()).toBe(1);
  }), 180_000);

  test('a file that lacks only the database fence is re-rendered with it instead of being held file_database_drift', async () => withBrain(databaseUrl, async b => {
    await b.remember();
    writeFileSync(b.path, stripFactsFence(b.file()).replace(/\n## Facts\n+/, '\n'));
    expect(b.file()).not.toContain(FACTS_FENCE_BEGIN);
    expect(await b.body()).toContain(CLAIM);
    b.bump();
    for (let i = 0; i < 3; i++) expect((await b.sync()).failedFiles ?? 0).toBe(0);
    expect(holds(b.root)['contact:people/c1']).toBeUndefined();
    expect(b.file()).toContain('Upstream 1');
    expect(b.file()).toContain(CLAIM);
    expect(await b.body()).toContain(CLAIM);
    expect(await b.activeFacts()).toBe(1);
  }), 180_000);

  test('a page already held for a real edit imports on retry-held once only the fence differs; a real edit is still held', async () => withBrain(databaseUrl, async b => {
    await b.remember();
    const bare = stripFactsFence(b.file()).replace(/\n## Facts\n+/, '\n');
    writeFileSync(b.path, `${bare}\nFILE-ONLY-EDIT: kept by the user.\n`);
    b.bump();
    for (let i = 0; i < 3; i++) expect((await b.sync()).failedFiles).toBe(1);
    expect(holds(b.root)['contact:people/c1']).toMatchObject({ code: 'file_database_drift', state: 'held' });
    expect(b.file()).toContain('FILE-ONLY-EDIT');
    writeFileSync(b.path, bare);
    await runRetryHeld(b.engine, [SOURCE]);
    expect((await b.sync()).failedFiles ?? 0).toBe(0);
    expect(holds(b.root)['contact:people/c1']?.state).not.toBe('held');
    expect(b.file()).toContain(CLAIM);
    expect(b.file()).toContain('Upstream 1');
  }), 180_000);
});
