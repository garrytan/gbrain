import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { admitCompanyBrain, previewCompanyBrain } from '../src/core/company-brain/admission.ts';
import { connectCompanyBrain, resumeCompanyBrain } from '../src/core/company-brain/runtime.ts';
import { performSync } from '../src/commands/sync.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { startPersistenceIpcServer, persistenceSocketPathForConfig, requestPersistenceAdministration } from '../src/core/persistence/ipc.ts';
import { maybeDelegateLocalAdministration } from '../src/core/persistence/local-client.ts';
import { readLocalWriter } from '../src/core/persistence/identity.ts';
import { withEnv } from './helpers/with-env.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

const home = mkdtempSync(join(tmpdir(), 'company-recovery-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], { encoding: 'utf8' }).trim();
async function fixture() {
  const root = mkdtempSync(join(home, 'repo-'));
  mkdirSync(join(root, 'people'));
  writeFileSync(join(root, 'people/operator.md'), '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nA synthetic contact.\n');
  await makeGitFixture(root); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic recovery fixture');
  return root;
}

test('a real SIGKILL after content commit resumes the same managed receipt on a reopened PGLite database', async () => {
  const root = await fixture();
  const dir = mkdtempSync(join(home, 'kill-'));
  const database = join(dir, 'db');
  const requestId = randomUUID();
  const script = `
    import { PGLiteEngine } from ${JSON.stringify(join(import.meta.dir, '../src/core/pglite-engine.ts'))};
    import { inspectCompanyBrain } from ${JSON.stringify(join(import.meta.dir, '../src/core/company-brain/inspection.ts'))};
    import { connectCompanyBrain } from ${JSON.stringify(join(import.meta.dir, '../src/core/company-brain/runtime.ts'))};
    const engine = new PGLiteEngine(); await engine.connect({database_path:${JSON.stringify(database)}}); await engine.initSchema();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    engine.replaceDerivedLinks = async () => { process.kill(process.pid, 'SIGKILL'); throw new Error('unreachable'); };
    await connectCompanyBrain(engine, {brainId:'company-example',sourceId:'wiki',remote:false,path:${JSON.stringify(root)},
      requestId:${JSON.stringify(requestId)},plan:await inspectCompanyBrain({path:${JSON.stringify(root)},profile:'company-brain'})});
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, GBRAIN_HOME: dir, DATABASE_URL: '', GBRAIN_DATABASE_URL: '' }, stdout: 'pipe', stderr: 'pipe' });
  const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  await withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine(); await engine.connect({ database_path: database });
    try {
      const [receipt] = await engine.executeRaw<{ phase: string; id: string }>('SELECT phase,id FROM source_ingestion_receipts WHERE id=$1::uuid', [requestId]);
      expect(receipt).toEqual({ phase: 'GRAPH', id: requestId });
      await expect(resumeCompanyBrain(engine, { brainId: 'company-example', sourceId: 'wiki', remote: false })).rejects.toHaveProperty('lockId', 'company-brain:wiki');
      await engine.executeRaw("UPDATE gbrain_cycle_locks SET acquired_at=now()-interval '2 minutes' WHERE id='company-brain:wiki' AND holder_pid=$1", [child.pid]);
      expect(await resumeCompanyBrain(engine, { brainId: 'company-example', sourceId: 'wiki', remote: false })).toMatchObject({ ok: true, receipt: { id: requestId, phase: 'COMPLETE' } });
      expect(existsSync(join(root, '.gitignore'))).toBe(false);
    } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  });
}, 120_000);

test('private administration delegates to the actual resident PGLite owner and refuses the stdio lane', async () => {
  const root = await fixture();
  const dir = mkdtempSync(join(home, 'resident-'));
  await withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const config = { engine: 'pglite' as const, database_path: join(dir, 'db') };
    const engine = new PGLiteEngine(); await engine.connect(config); await engine.initSchema();
    const provider = await createPersistenceIpcProvider(engine, config);
    const socket = persistenceSocketPathForConfig(config)!;
    const server = (await startPersistenceIpcServer(socket, provider))!;
    try {
      const plan = await inspectCompanyBrain({ path: root, profile: 'company-brain' });
      const params = { brain_id: 'company-example', source_id: 'wiki', path: root, plan, request_id: randomUUID() };
      const preview = await maybeDelegateLocalAdministration('company_brain_preview', params, config);
      expect(preview).toMatchObject({ handled: true, result: { sourceId: 'wiki', policy: { grantsUnchanged: true } } });
      expect(await engine.executeRaw("SELECT id FROM sources WHERE id='wiki'")).toHaveLength(0);
      const stdio = await readLocalWriter(engine, 'stdio');
      await expect(requestPersistenceAdministration(socket, { version: 1, kind: 'administration', brain_id: provider.brainId,
        operation: 'company_brain_connect', params, registration: stdio })).rejects.toMatchObject({ code: 'invalid_params' });
      const connected = await maybeDelegateLocalAdministration('company_brain_connect', params, config, { timeoutMs: 60_000 });
      expect(connected).toMatchObject({ handled: true, result: { ok: true, receipt: { phase: 'COMPLETE' } } });
    } finally { const closed = once(server.server, 'close'); server.close(); await closed; await disposePersistenceConsumer(engine); await engine.disconnect(); }
  });
}, 120_000);

test('preview refuses missing receipt migration without creating any database objects', async () => {
  const root = await fixture();
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  try {
    await engine.executeRaw('DROP TABLE source_ingestion_receipts');
    const plan = await inspectCompanyBrain({ path: root, profile: 'company-brain' });
    await expect(previewCompanyBrain(engine, { brainId: 'company-example', sourceId: 'wiki', path: root, plan, remote: false })).rejects.toMatchObject({ code: 'destination_not_ready' });
    expect(await engine.executeRaw("SELECT to_regclass('source_ingestion_receipts')::text AS table_name")).toEqual([{ table_name: null }]);
    expect(await engine.getConfig('schema_pack')).toBeNull();
  } finally { await engine.disconnect(); }
}, 120_000);

test('mixed sync --all continues the keyless profile while reporting missing credentials for ordinary sources', async () => {
  const root = await fixture();
  const other = await fixture();
  const missingPolicy = await fixture();
  const dir = mkdtempSync(join(home, 'all-'));
  const database = join(dir, 'db');
  await withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine(); await engine.connect({ database_path: database }); await engine.initSchema();
    try {
      await admitCompanyBrain(engine, { brainId: 'company-example', sourceId: 'wiki', path: root,
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }), remote: false });
      await admitCompanyBrain(engine, { brainId: 'company-example', sourceId: 'policy-missing', path: missingPolicy,
        plan: await inspectCompanyBrain({ path: missingPolicy, profile: 'company-brain' }), remote: false });
      await engine.executeRaw("UPDATE sources SET config=config-'company_brain' WHERE id='policy-missing'");
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('ordinary','ordinary',$1,'{}')", [other]);
    } finally { await engine.disconnect(); }
  });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: database }));
  const script = `
    import { PGLiteEngine } from ${JSON.stringify(join(import.meta.dir, '../src/core/pglite-engine.ts'))};
    import { runSync } from ${JSON.stringify(join(import.meta.dir, '../src/commands/sync.ts'))};
    const engine=new PGLiteEngine(); await engine.connect({database_path:${JSON.stringify(database)}});
    try { await runSync(engine,['--all','--json','--serial']); } finally { await engine.disconnect(); }
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: dir, env: { ...process.env, GBRAIN_HOME: dir,
    OPENAI_API_KEY: '', VOYAGE_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OLLAMA_BASE_URL: '',
    DATABASE_URL: '', GBRAIN_DATABASE_URL: '', GBRAIN_BACKUP_CHECK: '0' }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toMatchObject({ code: 1 });
  const result = JSON.parse(stdout);
  expect(result.sources.find((source: { source_id: string }) => source.source_id === 'wiki')).toMatchObject({ status: 'ok' });
  expect(result.sources.find((source: { source_id: string }) => source.source_id === 'ordinary')).toMatchObject({ status: 'error' });
  expect(result.sources.find((source: { source_id: string }) => source.source_id === 'policy-missing')).toMatchObject({ status: 'error' });
  expect(result.sources.find((source: { source_id: string }) => source.source_id === 'policy-missing').error).toContain('durable company approval');
  expect(existsSync(join(root, '.gitignore'))).toBe(false);
}, 120_000);

for (const managed of [false, true]) test(`hostile Git scripts cannot execute through real ${managed ? 'managed' : 'legacy'} profile connect or sync`, async () => {
  const root = await fixture();
  const dir = mkdtempSync(join(home, 'hostile-'));
  const marker = join(dir, 'executed');
  const script = join(dir, 'marker.sh');
  writeFileSync(script, `#!/bin/sh\nprintf executed >> '${marker}'\nexit 1\n`); chmodSync(script, 0o700);
  writeFileSync(join(root, '.gitattributes'), '*.md filter=hostile diff=hostile\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic attributes');
  const firstCommit = git(root, 'rev-parse', 'HEAD');
  const changed = '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nA revised synthetic contact.\n';
  writeFileSync(join(root, 'people/operator.md'), changed);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic next revision');
  const nextCommit = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '--detach', '-q', firstCommit);
  const hooks = join(dir, 'hooks'); mkdirSync(hooks);
  for (const hook of ['post-checkout', 'post-merge', 'pre-commit', 'reference-transaction', 'fsmonitor-watchman', 'post-rewrite']) {
    const path = join(hooks, hook); writeFileSync(path, `#!/bin/sh\nprintf executed >> '${marker}'\nexit 1\n`); chmodSync(path, 0o700);
  }
  for (const [key, value] of Object.entries({ 'core.fsmonitor': script, 'diff.external': script, 'diff.hostile.command': script,
    'filter.hostile.clean': script, 'filter.hostile.smudge': script, 'filter.hostile.process': script,
    'core.hooksPath': hooks, 'core.sshCommand': script, 'remote.origin.url': 'ssh://git@example.invalid/fixture.git' })) git(root, 'config', key, value);
  await withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    try {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
      const input = { brainId: 'company-example', sourceId: 'wiki', remote: false, path: root,
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }) };
      expect(input.plan.ready).toBe(true);
      expect((await connectCompanyBrain(engine, input)).ok).toBe(true);
      expect(existsSync(marker)).toBe(false);
      git(root, '-c', 'core.fsmonitor=false', 'read-tree', nextCommit);
      git(root, '-c', 'core.fsmonitor=false', 'update-ref', 'HEAD', nextCommit);
      writeFileSync(join(root, 'people/operator.md'), changed);
      expect(existsSync(marker)).toBe(false);
      expect((await performSync(engine, { sourceId: 'wiki' })).status).toBe('synced');
      expect(existsSync(marker)).toBe(false);
      expect((await engine.getPage('people/operator', { sourceId: 'wiki' }))?.compiled_truth).toContain('revised synthetic contact');
    } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  });
}, 120_000);
