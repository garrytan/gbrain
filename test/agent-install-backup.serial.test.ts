/** Real setup + finite CLI + complete PGLite recovery, entirely within temporary roots. */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupInAgent } from '../src/core/agent-install/setup.ts';
import { runAgentSetupCli } from '../src/core/agent-install/entry.ts';
import { acquireBootstrapLock } from '../src/core/bootstrap/lock.ts';
import { readInstallReceipt, writeInstallReceipt } from '../src/core/agent-install/state.ts';
import { createPgliteBackup, rebaseManagedConfig, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { writeBackupArchive } from '../src/core/backup/archive.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { acquireLock, releaseLock, PgliteBusyError } from '../src/core/pglite-lock.ts';
import { withEnv } from './helpers/with-env.ts';

let temporary: string;
let root: string;
let bundle: string;
let archive: string;
const sourceRef = 'a'.repeat(40);
const repo = resolve(import.meta.dir, '..');

async function withBrain<T>(at: string, fn: (engine: PGLiteEngine) => Promise<T>): Promise<T> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(at, '.gbrain', 'brain.pglite') });
  try { return await fn(engine); } finally { await engine.disconnect(); }
}

async function launched(args: string[], at = root): Promise<string> {
  const child = Bun.spawn([join(at, 'bin', 'gbrain'), ...args], {
    cwd: '/', env: { ...process.env, DATABASE_URL: 'postgres://foreign.invalid/wrong', GBRAIN_HOME: join(temporary, 'wrong-home'), GBRAIN_SOURCE: 'wrong-source' }, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  try {
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Installed command failed (${code}): ${errors}`);
    return output;
  } finally { clearTimeout(timer); }
}

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'gbrain-agent-recovery-'));
  root = join(temporary, 'brain'); bundle = join(temporary, 'bundle'); archive = join(temporary, 'brain.gbrain-backup');
  const pkg = join(bundle, 'app', 'node_modules', 'gbrain');
  mkdirSync(join(pkg, 'src', 'core', 'agent-install'), { recursive: true });
  mkdirSync(join(pkg, 'scripts'));
  // A tiny bundle forwards to the REAL CLI under the test checkout. It tests
  // installed executable handoff without copying the whole checkout/deps.
  copyFileSync(process.execPath, join(bundle, 'bun')); chmodSync(join(bundle, 'bun'), 0o700);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'gbrain', version: '0.0.0-test' }));
  writeFileSync(join(pkg, 'src', 'cli.ts'), `const c=Bun.spawn([process.execPath,'--no-env-file',${JSON.stringify(join(repo, 'src', 'cli.ts'))},...process.argv.slice(2)],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(await c.exited);\n`);
  writeFileSync(join(pkg, 'src', 'core', 'agent-install', 'entry.ts'), '// Fixture entrypoint; service is exercised directly.\n');
  copyFileSync(join(repo, 'scripts', 'setup-in-agent.sh'), join(pkg, 'scripts', 'setup-in-agent.sh'));
  await withEnv({ DATABASE_URL: 'postgres://wrong.invalid/foreign', GBRAIN_DATABASE_URL: 'postgres://wrong.invalid/foreign', OPENAI_API_KEY: 'must-not-persist', GBRAIN_BRAIN_ID: 'foreign', GBRAIN_SOURCE: 'foreign' }, () => setupInAgent({ root, harness: 'grok-bot', bundle, sourceRef }));
  await withBrain(root, async engine => {
    await engine.executeRaw(`INSERT INTO facts (fact, source, source_id) VALUES ($1, 'fixture', 'default')`, ['unique DB-only durable fact']);
    const queue = new MinionQueue(engine);
    for (const status of ['waiting', 'active', 'delayed', 'waiting-children', 'paused', 'completed']) {
      // Current application submission stamps durable authority. Model each
      // lifecycle state without executing work; active represents one claim.
      const job = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
      if (status !== 'waiting') await engine.executeRaw(
        "UPDATE minion_jobs SET status=$1, claim_generation=claim_generation+CASE WHEN $1='active' THEN 1 ELSE 0 END WHERE id=$2",
        [status, job.id],
      );
    }
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('external', 'External fixture', $1)`, [join(temporary, 'outside')]);
    await engine.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_id, source_path) VALUES ('recovery-note', 'note', 'Recovery fixture', '', '', '{}', 'fixture', 'default', $1)`, [join(root, 'memory', 'note.md')]);
  });
  writeFileSync(join(root, 'memory', 'note.md'), '# Local note\nA source file that must survive.\n');
});

afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

test('restored configuration never traverses or copies inherited path fields', () => {
  const inheritedContainer = { skills_dir: join(root, 'instructions') };
  const prototype = Object.prototype;
  const priorContainer = Object.getOwnPropertyDescriptor(prototype, 'mcp');
  const priorLeaf = Object.getOwnPropertyDescriptor(prototype, 'session_corpus_dir');
  try {
    Object.defineProperty(prototype, 'mcp', { value: inheritedContainer, configurable: true, writable: true });
    Object.defineProperty(prototype, 'session_corpus_dir', { value: join(root, 'memory'), configurable: true, writable: true });
    const detached: string[] = [];
    const restored = rebaseManagedConfig({ engine: 'pglite', dream: { synthesize: {} } }, root, join(temporary, 'new-root'), ['memory', 'instructions'], detached);
    expect(inheritedContainer.skills_dir).toBe(join(root, 'instructions'));
    expect(Object.hasOwn(restored, 'mcp')).toBe(false);
    expect(Object.hasOwn(restored.dream!.synthesize!, 'session_corpus_dir')).toBe(false);
    expect(detached).toEqual([]);
  } finally {
    if (priorContainer) Object.defineProperty(prototype, 'mcp', priorContainer);
    else Reflect.deleteProperty(prototype, 'mcp');
    if (priorLeaf) Object.defineProperty(prototype, 'session_corpus_dir', priorLeaf);
    else Reflect.deleteProperty(prototype, 'session_corpus_dir');
  }
});

test('real keyless initialization stays local, and repair preserves facts/configuration', async () => {
  const configPath = join(root, '.gbrain', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(config.engine).toBe('pglite'); expect(config.database_path).toBe(join(root, '.gbrain', 'brain.pglite'));
  expect(config.openai_api_key).toBeUndefined(); expect(config.database_url).toBeUndefined();
  config.embedding_disabled = false; config.schema_pack = 'gbrain-base';
  writeFileSync(configPath, JSON.stringify(config));
  const before = readFileSync(configPath, 'utf8');
  const first = readInstallReceipt(root)!;
  rmSync(join(root, first.artifact!.directory, 'bun'));
  const result = await setupInAgent({ root, harness: 'grok-bot', bundle, sourceRef });
  expect(result.status).toBe('repaired');
  expect(readFileSync(configPath, 'utf8')).toBe(before);
  expect(readInstallReceipt(root)!.installation_id).toBe(first.installation_id);
  expect(readInstallReceipt(root)!.native.routine_id).toBe(first.native.routine_id);
  expect(await withBrain(root, e => e.executeRaw('SELECT fact FROM facts'))).toContainEqual({ fact: 'unique DB-only durable fact' });
});

test('a failed upgrade resumes its migration before reporting the existing brain ready', async () => {
  const upgradingRoot = join(temporary, 'upgrade-root');
  const upgradingBundle = join(temporary, 'upgrade-bundle');
  const failure = join(temporary, 'migration-failure');
  const attempts = join(temporary, 'migration-attempts');
  cpSync(bundle, upgradingBundle, { recursive: true });
  writeFileSync(join(upgradingBundle, 'app', 'node_modules', 'gbrain', 'src', 'cli.ts'), `
import { appendFileSync, existsSync } from 'node:fs';
if (process.argv.includes('--migrate-only')) {
  appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n');
  if (existsSync(${JSON.stringify(failure)})) process.exit(43);
}
const child = Bun.spawn([process.execPath, '--no-env-file', ${JSON.stringify(join(repo, 'src', 'cli.ts'))}, ...process.argv.slice(2)], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
`);
  await setupInAgent({ root: upgradingRoot, harness: 'muse', bundle: upgradingBundle, sourceRef });
  await withBrain(upgradingRoot, e => e.executeRaw(`INSERT INTO facts (fact, source, source_id) VALUES ('upgrade recovery fixture', 'fixture', 'default')`));
  const original = readInstallReceipt(upgradingRoot)!;
  const configBefore = readFileSync(join(upgradingRoot, '.gbrain', 'config.json'), 'utf8');
  writeFileSync(failure, 'fail once');
  const upgradedRef = 'b'.repeat(40);
  await expect(setupInAgent({ root: upgradingRoot, harness: 'muse', bundle: upgradingBundle, sourceRef: upgradedRef, upgrade: true })).rejects.toThrow('exit 43');
  const pending = readInstallReceipt(upgradingRoot)!;
  expect(pending.artifact!.source_ref).toBe(upgradedRef);
  expect(pending.pending_runtime_migration).toBe(true);
  expect(pending.state).toBe('installing');
  expect(pending.last_failure?.code).toBe('setup_command_failed');
  expect(pending.recovery?.command).toContain(join(upgradingRoot, 'bin', 'gbrain-setup'));
  expect(pending.pending_steps).toContain('migrate_database');
  rmSync(failure);
  const repaired = await setupInAgent({ root: upgradingRoot, harness: 'muse', bundle: upgradingBundle, sourceRef: upgradedRef });
  expect(repaired.status).toBe('repaired');
  expect(readFileSync(attempts, 'utf8')).toBe('attempt\nattempt\n');
  const complete = readInstallReceipt(upgradingRoot)!;
  expect(complete.pending_runtime_migration).toBe(false);
  expect(complete.state).toBe('ready');
  expect(complete.last_failure).toBeUndefined();
  expect(complete.pending_steps).not.toContain('migrate_database');
  expect(complete.pending_steps).toContain('confirm_search_mode');
  expect(complete.pending_steps).toContain('enable_native_skill');
  expect(complete.pending_steps).toContain('verify_new_conversation');
  expect(complete.installation_id).toBe(original.installation_id);
  expect(complete.native).toEqual(original.native);
  expect(readFileSync(join(upgradingRoot, '.gbrain', 'config.json'), 'utf8')).toBe(configBefore);
  expect(await withBrain(upgradingRoot, e => e.executeRaw('SELECT fact FROM facts'))).toContainEqual({ fact: 'upgrade recovery fixture' });
});

test('existing database files after an interrupted init do not certify unfinished schema migrations', async () => {
  // This setup recovery has no running work. The separate backup fixture keeps
  // its active jobs for the restore-quarantine assertions below.
  const interruptedRoot = join(temporary, 'interrupted-root');
  await setupInAgent({ root: interruptedRoot, harness: 'grok-bot', bundle, sourceRef });
  const receipt = readInstallReceipt(interruptedRoot)!;
  const schema = await withBrain(interruptedRoot, async engine => {
    await engine.executeRaw("INSERT INTO facts (fact, source, source_id) VALUES ('interrupted init durable fact', 'fixture', 'default')");
    const current = Number(await engine.getConfig('version'));
    await engine.setConfig('version', String(current - 1));
    return current;
  });
  receipt.initialized = false; receipt.state = 'installing';
  writeInstallReceipt(receipt);
  const repaired = await setupInAgent({ root: interruptedRoot, harness: 'grok-bot', bundle, sourceRef });
  expect(repaired.status).toBe('repaired');
  expect(readInstallReceipt(interruptedRoot)!.schema_version).toBe(schema);
  expect(readInstallReceipt(interruptedRoot)!.pending_runtime_migration).toBe(false);
  expect(await withBrain(interruptedRoot, e => e.executeRaw('SELECT fact FROM facts'))).toContainEqual({ fact: 'interrupted init durable fact' });
});

test('separate installed CLI processes remember, recall and forget despite hostile routing', async () => {
  const unique = `installation-canary-${crypto.randomUUID()}`;
  const remembered = JSON.parse(await launched(['remember', unique, '--provenance', 'hermetic setup test', '--entity', 'projects/setup-test', '--json']));
  expect(remembered.status).toBe('inserted');
  expect(await launched(['recall', '--grep', unique, '--json'])).toContain(unique);
  await launched(['forget', String(remembered.id), '--reason', 'setup test complete']);
  expect(await launched(['recall', '--grep', unique, '--json'])).not.toContain(unique);
  expect(existsSync(join(temporary, 'wrong-home'))).toBe(false);
});

test('user-modified instructions and unowned roots are never overwritten', async () => {
  const path = join(root, 'instructions', 'gbrain-skill.md'); const original = readFileSync(path, 'utf8');
  writeFileSync(path, 'My personal edits');
  await expect(setupInAgent({ root, harness: 'grok-bot', bundle, sourceRef })).rejects.toThrow('will not be overwritten');
  expect(readFileSync(path, 'utf8')).toBe('My personal edits');
  writeFileSync(path, original);
  const foreign = join(temporary, 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'note'), 'keep');
  await expect(setupInAgent({ root: foreign, harness: 'muse', bundle, sourceRef })).rejects.toThrow('unowned state');
  expect(readdirSync(foreign)).toEqual(['note']);
});

test('write-ahead generated-file state resumes across a killed write', async () => {
  const receipt = readInstallReceipt(root)!;
  const path = 'instructions/gbrain-skill.md';
  receipt.pending_files = { [path]: { before: receipt.owned_files[path], after: receipt.owned_files[path] } };
  writeInstallReceipt(receipt);
  await setupInAgent({ root, harness: 'grok-bot', bundle, sourceRef });
  expect(readInstallReceipt(root)!.pending_files?.[path]).toBeUndefined();
});

test('full backup restores DB-only facts/files, rebases sources, quarantines all unfinished jobs', async () => {
  const cfgPath = join(root, '.gbrain', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); cfg.openai_api_key = 'fixture-private';
  cfg.storage = { backend: 'local', bucket: 'fixture', localPath: join(root, 'memory', 'attachments') };
  cfg.mcp = { skills_dir: join(temporary, 'external-skills') };
  cfg.autopilot = { nightly_quality_probe: { enabled: true } };
  writeFileSync(cfgPath, JSON.stringify(cfg));
  mkdirSync(join(root, 'memory', 'attachments'));
  writeFileSync(join(root, 'memory', 'attachments', 'fixture.txt'), 'managed attachment');
  mkdirSync(join(root, '.gbrain', 'credential-deliveries'));
  writeFileSync(join(root, '.gbrain', 'credential-deliveries', 'fixture.json'), '{"client_secret":"excluded-file"}');
  const excludedManaged = ['memory/credentials.json', 'memory/auth.json', 'memory/token.txt', 'instructions/.env.local',
    'memory/cache/cache.json', 'memory/browser-profile/Cookies', 'memory/backups/old.gbrain-backup',
    'memory/prior.gbrain-backup', 'memory/renamed-prior-snapshot'];
  for (const path of excludedManaged) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'sensitive-excluded-fixture');
  }
  // Backups can be copied into a managed source or renamed without a suffix.
  // Neither may recursively include an older installation's private payload.
  const renamedArchive = join(root, 'memory', 'renamed-prior-snapshot');
  rmSync(renamedArchive);
  writeBackupArchive(renamedArchive, {}, [{ path: 'private-record', file: join(root, 'memory', 'prior.gbrain-backup') }]);
  writeFileSync(join(root, 'memory', 'credentials.md'), '# Remembered credential rotation procedure\nNo actual credential.\n');
  const connectorCommandMarker = join(temporary, 'connector-command-ran');
  await withBrain(root, async engine => {
    await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)', [
      'google-fixture', 'Google fixture', join(root, 'memory', 'google'),
      JSON.stringify({ kind: 'google', federated: true, g_account: 'fixture-account', g_services: 'gmail', g_access: 'command', g_token_command: `touch '${connectorCommandMarker}'`, syncEnabled: true }),
    ]);
    await engine.setConfig('connectors.chatgpt.auto_sync', 'true');
    await engine.setConfig('autopilot.auto_drain.enabled', 'true');
    await engine.setConfig('sync.repo_path', join(root, 'memory'));
    await engine.setConfig('dream.synthesize.session_corpus_dir', join(temporary, 'external-sessions'));
  });
  const created = await createPgliteBackup({ root, output: archive });
  expect(created.manifest.classification).toBe('sensitive-full-database-state');
  expect(statSync(archive).mode & 0o777).toBe(0o600);
  expect(created.manifest.entries.some(e => e.path.includes('credential-deliveries'))).toBe(false);
  for (const path of excludedManaged) expect(created.manifest.entries.some(e => e.path === `files/${path}`)).toBe(false);
  expect(created.manifest.entries.some(e => e.path === 'files/memory/credentials.md')).toBe(true);
  expect((created.manifest.omitted as string[]).some(line => line.includes('instructions/.env.local'))).toBe(true);
  expect((created.manifest.omitted as string[]).some(line => line.includes('memory/browser-profile'))).toBe(true);
  for (const path of ['memory/prior.gbrain-backup', 'memory/renamed-prior-snapshot']) {
    expect(created.manifest.omitted).toContain(`Excluded managed path ${path}: previous GBrain backup archive.`);
  }
  const restored = join(temporary, 'restored');
  const result = await restorePgliteBackup({ archive, into: restored });
  expect(result.quarantined_jobs).toBe(5);
  expect(readFileSync(join(restored, 'memory', 'note.md'), 'utf8')).toContain('must survive');
  for (const path of excludedManaged) expect(existsSync(join(restored, path))).toBe(false);
  expect(readFileSync(join(restored, 'memory', 'credentials.md'), 'utf8')).toContain('Remembered credential rotation');
  const restoredCfg = JSON.parse(readFileSync(join(restored, '.gbrain', 'config.json'), 'utf8'));
  expect(restoredCfg.database_path).toBe(join(restored, '.gbrain', 'brain.pglite'));
  expect(restoredCfg.openai_api_key).toBeUndefined();
  expect(restoredCfg.storage.localPath).toBe(join(restored, 'memory', 'attachments'));
  expect(restoredCfg.mcp.skills_dir).toBeUndefined();
  expect(restoredCfg.autopilot.nightly_quality_probe.enabled).toBe(false);
  expect(readFileSync(join(restoredCfg.storage.localPath, 'fixture.txt'), 'utf8')).toBe('managed attachment');
  await withBrain(restored, async e => {
    expect(await e.executeRaw('SELECT fact FROM facts')).toContainEqual({ fact: 'unique DB-only durable fact' });
    expect(await e.executeRaw(`SELECT local_path FROM sources WHERE id = 'default'`)).toEqual([{ local_path: join(restored, 'memory') }]);
    expect(await e.executeRaw(`SELECT local_path FROM sources WHERE id = 'external'`)).toEqual([{ local_path: null }]);
    expect(await e.executeRaw(`SELECT source_path FROM pages WHERE slug = 'recovery-note'`)).toEqual([{ source_path: join(restored, 'memory', 'note.md') }]);
    expect(await e.executeRaw(`SELECT count(*)::int AS n FROM minion_jobs WHERE status = 'cancelled' AND data->>'__restore_previous_status' IS NOT NULL`)).toEqual([{ n: 5 }]);
    expect(await e.executeRaw(`SELECT count(*)::int AS n FROM minion_jobs WHERE status = 'completed'`)).toEqual([{ n: 1 }]);
    const [connector] = await e.executeRaw<{ local_path: string | null; config: Record<string, unknown> }>(`SELECT local_path, config FROM sources WHERE id = 'google-fixture'`);
    expect(connector.local_path).toBeNull();
    expect(connector.config).toMatchObject({ federated: true, syncEnabled: false });
    expect(connector.config.kind).toBeUndefined();
    expect(connector.config.g_token_command).toBeUndefined();
    expect(await e.getConfig('connectors.chatgpt.auto_sync')).toBe('false');
    expect(await e.getConfig('autopilot.auto_drain.enabled')).toBe('false');
    expect(await e.getConfig('sync.repo_path')).toBe(join(restored, 'memory'));
    expect(await e.getConfig('dream.synthesize.session_corpus_dir')).toBeNull();
    const { performSync } = await import('../src/commands/sync.ts');
    await expect(performSync(e, { sourceId: 'google-fixture' })).rejects.toThrow('no local_path');
    // An explicit repo override must not revive the archived API kind or its
    // credential command. The ordinary non-git directory then fails locally.
    await expect(performSync(e, { sourceId: 'google-fixture', repoPath: join(restored, 'memory') })).rejects.toThrow();
    expect(existsSync(connectorCommandMarker)).toBe(false);
  });
  const detached = JSON.parse(readFileSync(join(restored, '.gbrain', 'restore-detached.json'), 'utf8'));
  expect(detached.sources.find((s: { id: string }) => s.id === 'google-fixture').config.g_account).toBe('fixture-account');
  expect(statSync(join(restored, '.gbrain', 'restore-detached.json')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(restored, '.gbrain', 'autopilot-paused'), 'utf8')).toContain('backup restore');
  expect(existsSync(join(restored, 'bin', 'gbrain'))).toBe(false);
  await setupInAgent({ root: restored, harness: 'grok-bot', bundle, sourceRef });
  expect(readFileSync(join(restored, 'instructions', 'gbrain-skill.md'), 'utf8')).toContain(join(restored, 'bin', 'gbrain'));
  expect(readInstallReceipt(restored)!.native.verification).toBe('unverified');
  const restoredCanary = `restored-installation-canary-${crypto.randomUUID()}`;
  const written = JSON.parse(await launched(['remember', restoredCanary, '--provenance', 'explicit restore verification', '--entity', 'projects/restore-test', '--json'], restored));
  expect(written.status).toBe('inserted');
  expect(await launched(['recall', '--grep', restoredCanary, '--json'], restored)).toContain(restoredCanary);
  expect(await withBrain(root, e => e.executeRaw('SELECT id FROM facts WHERE fact = $1', [restoredCanary]))).toEqual([]);
  expect(await launched(['recall', '--grep', restoredCanary, '--json'])).not.toContain(restoredCanary);
  expect(await withBrain(root, e => e.executeRaw(`SELECT count(*)::int AS n FROM minion_jobs WHERE status = 'waiting'`))).toEqual([{ n: 1 }]);
});

test('restore rejects existing targets and corrupt archives without touching the original brain', async () => {
  await expect(restorePgliteBackup({ archive, into: root })).rejects.toThrow('never overwritten');
  const corrupt = join(temporary, 'corrupt'); writeFileSync(corrupt, 'not a backup');
  const into = join(temporary, 'failed-restore');
  await expect(restorePgliteBackup({ archive: corrupt, into })).rejects.toThrow();
  expect(JSON.parse(readFileSync(join(into, 'restore-receipt.json'), 'utf8')).state).toBe('failed');
  await expect(setupInAgent({ root: into, harness: 'grok-bot', bundle, sourceRef, adopt: true })).rejects.toThrow('incomplete restore');
  expect(existsSync(join(into, '.gbrain', 'config.json'))).toBe(false);
  expect(await withBrain(root, e => e.executeRaw('SELECT fact FROM facts'))).toContainEqual({ fact: 'unique DB-only durable fact' });
});

test('restore rejects a valid payload with a false schema version in its archive inventory', async () => {
  const bytes = readFileSync(archive);
  const prefixSize = bytes.indexOf('\n') + 1;
  const manifestSize = bytes.readUInt32BE(prefixSize);
  const metadata = JSON.parse(bytes.subarray(prefixSize + 4, prefixSize + 4 + manifestSize).toString());
  metadata.schema_version -= 1;
  const changed = Buffer.from(JSON.stringify(metadata));
  const length = Buffer.alloc(4); length.writeUInt32BE(changed.length);
  const alteredArchive = join(temporary, 'false-schema.gbrain-backup');
  writeFileSync(alteredArchive, Buffer.concat([bytes.subarray(0, prefixSize), length, changed, bytes.subarray(prefixSize + 4 + manifestSize)]));
  const into = join(temporary, 'false-schema-restore');
  await expect(restorePgliteBackup({ archive: alteredArchive, into })).rejects.toMatchObject({ code: 'backup_schema_mismatch' });
  expect(JSON.parse(readFileSync(join(into, 'restore-receipt.json'), 'utf8')).state).toBe('failed');
  expect(existsSync(join(into, '.gbrain', 'config.json'))).toBe(false);
  expect(await withBrain(root, e => e.executeRaw('SELECT fact FROM facts'))).toContainEqual({ fact: 'unique DB-only durable fact' });
});

test('interrupted publication preserves private recovery staging and refuses an incomplete destination', async () => {
  const into = join(temporary, 'interrupted-publication');
  const originalState = () => withBrain(root, async engine => ({
    facts: await engine.executeRaw('SELECT id, fact, expired_at FROM facts ORDER BY id'),
    jobs: await engine.executeRaw('SELECT id, status, data FROM minion_jobs ORDER BY id'),
  }));
  const before = await originalState();
  const moved: string[] = [];
  const rename = fs.renameSync;
  const publication = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    const source = String(from); const destination = String(to);
    const child = ['.gbrain', 'instructions', 'memory'].find(name => destination === join(into, name)
      && source.startsWith(join(into, '.restore-')) && source.endsWith(`/restored/${name}`));
    if (child && moved.length === 1) throw new Error('injected restore publication interruption');
    rename(from, to);
    if (child) moved.push(child);
  });
  try { await expect(restorePgliteBackup({ archive, into })).rejects.toThrow('injected restore publication interruption'); }
  finally { publication.mockRestore(); }
  expect(moved).toHaveLength(1);
  expect(existsSync(join(into, moved[0]))).toBe(true);
  expect(JSON.parse(readFileSync(join(into, 'restore-receipt.json'), 'utf8'))).toMatchObject({ state: 'failed', original_preserved: true });
  expect(statSync(into).mode & 0o777).toBe(0o700);
  const staging = readdirSync(into).filter(name => name.startsWith('.restore-'));
  expect(staging).toHaveLength(1);
  expect(statSync(join(into, staging[0])).mode & 0o777).toBe(0o700);
  expect(existsSync(join(into, staging[0], 'payload', 'database.tar'))).toBe(true);
  expect(readdirSync(join(into, staging[0], 'restored')).length).toBeGreaterThan(0);
  await expect(setupInAgent({ root: into, harness: 'grok-bot', bundle, sourceRef })).rejects.toThrow('incomplete restore');
  await expect(restorePgliteBackup({ archive, into })).rejects.toMatchObject({ code: 'restore_target_exists' });
  expect(await originalState()).toEqual(before);
});

test('a changing managed file inventory prevents backup publication and preserves the brain', async () => {
  const output = join(temporary, 'changing-files.gbrain-backup');
  const added = join(root, 'memory', 'concurrent-writer.md');
  const connect = PGLiteEngine.prototype.connect;
  const probe = spyOn(PGLiteEngine.prototype, 'connect').mockImplementation(async function (this: PGLiteEngine, config) {
    await connect.call(this, config);
    const dump = this.db.dumpDataDir.bind(this.db);
    this.db.dumpDataDir = async (...args) => {
      const result = await dump(...args);
      writeFileSync(added, '# A source file added during the database snapshot\n');
      return result;
    };
  });
  try { await expect(createPgliteBackup({ root, output })).rejects.toMatchObject({ code: 'writers_active' }); }
  finally { probe.mockRestore(); rmSync(added, { force: true }); }
  expect(existsSync(output)).toBe(false);
  expect(await withBrain(root, e => e.executeRaw('SELECT fact FROM facts'))).toContainEqual({ fact: 'unique DB-only durable fact' });
});

test('PGLite busy failures are typed and preserve the live lock', async () => {
  const dir = join(temporary, 'locked'); const lock = await acquireLock(dir);
  try {
    try { await acquireLock(dir, { timeoutMs: 20 }); throw new Error('unexpected lock acquisition'); }
    catch (error) { expect(error).toBeInstanceOf(PgliteBusyError); expect((error as PgliteBusyError).code).toBe('pglite_busy'); }
    expect(existsSync(join(dir, '.gbrain-lock', 'lock'))).toBe(true);
  } finally { await releaseLock(lock); }
});

test('setup JSON preserves retryable busy classification and never recommends deleting a live lock', async () => {
  const setupLock = await acquireBootstrapLock(root);
  const calls: string[] = [];
  const output = spyOn(console, 'log').mockImplementation(value => { calls.push(String(value)); });
  const args = ['--root', root, '--harness', 'grok-bot', '--bundle', bundle, '--source-ref', sourceRef, '--json'];
  try {
    const before = readFileSync(join(setupLock.dir, 'meta.json'), 'utf8');
    expect(await runAgentSetupCli(args)).toBe(1);
    expect(JSON.parse(calls.pop()!)).toMatchObject({ ok: false, reason: 'setup_busy', retryable: true });
    expect(readFileSync(join(setupLock.dir, 'meta.json'), 'utf8')).toBe(before);
  } finally { setupLock.release(); output.mockRestore(); }

  const lock = await acquireLock(join(root, '.gbrain', 'brain.pglite'));
  const lockPath = join(lock.lockDir!, 'lock');
  const prior = JSON.parse(readFileSync(lockPath, 'utf8'));
  writeFileSync(lockPath, JSON.stringify({ ...prior, subcommand: 'serve' }));
  const databaseOutput = spyOn(console, 'log').mockImplementation(value => { calls.push(String(value)); });
  try {
    expect(await runAgentSetupCli(args)).toBe(1);
    const busy = JSON.parse(calls.pop()!);
    expect(busy).toMatchObject({ ok: false, reason: 'pglite_busy', retryable: true });
    expect(busy.recovery_action).toContain('Do not remove its lock');
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    // A runtime upgrade reaches the same lock through a separate migration
    // CLI process; that boundary must preserve the retryable result too.
    const pending = readInstallReceipt(root)!;
    pending.pending_runtime_migration = true; pending.state = 'installing';
    writeInstallReceipt(pending);
    expect(await runAgentSetupCli(args)).toBe(1);
    expect(JSON.parse(calls.pop()!)).toMatchObject({ ok: false, reason: 'pglite_busy', retryable: true });
    expect(readInstallReceipt(root)!.pending_runtime_migration).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
  } finally { databaseOutput.mockRestore(); await releaseLock(lock); }
  await setupInAgent({ root, harness: 'grok-bot', bundle, sourceRef });
  expect(readInstallReceipt(root)!.pending_runtime_migration).toBe(false);
});
