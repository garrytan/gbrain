import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentInstallError, checkedManagedPaths, confinedPath, privateWrite, readInstallReceipt, sha256, type AgentInstallReceipt } from '../src/core/agent-install/state.ts';
import { extractPgliteDump, readBackupArchive, writeBackupArchive } from '../src/core/backup/archive.ts';
import { createPgliteBackup, rebaseManagedConfig, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { rebaseRestorePath, relativeBackupPath } from '../src/core/backup/quarantine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getEmbeddingDimensions } from '../src/core/ai/gateway.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';
import * as privacy from '../src/core/backup/private-path.ts';

let temporary: string;
let root: string;
let archive: string;
let archiveHash: string;
let original: Awaited<ReturnType<typeof databaseState>>;
let originalFiles: string[];
const attachment = Buffer.from([0, 1, 2, 255, 128, 10]);
const emptyDirectories = ['pg_snapshots', 'pg_twophase', 'pg_replslot', 'pg_commit_ts'];
const queries = {
  pages: 'SELECT id, source_id, slug, title, compiled_truth, timeline, frontmatter, content_hash, source_path, generation::text, created_at::text, updated_at::text FROM pages ORDER BY id',
  chunks: "SELECT id, page_id, chunk_index, chunk_text, model, embedded_text_hash, encode(vector_send(embedding), 'hex') AS vector, embedded_at::text FROM content_chunks ORDER BY id",
  facts: 'SELECT id, fact, source, source_id FROM facts ORDER BY id',
  sources: 'SELECT id, local_path, config FROM sources ORDER BY id',
  jobs: 'SELECT id, status, data, lock_token, lock_until::text FROM minion_jobs ORDER BY id',
  settings: "SELECT key, value FROM config WHERE key IN ('sync.repo_path', 'mcp.skills_dir', 'connectors.chatgpt.auto_sync') ORDER BY key",
};

async function databaseState(at: string) {
  const engine = new PGLiteEngine();
  await engine.connectForRestore({ engine: 'pglite', database_path: join(at, '.gbrain', 'brain.pglite') });
  try {
    const state: Record<keyof typeof queries, Record<string, unknown>[]> = {} as never;
    for (const [key, sql] of Object.entries(queries)) state[key as keyof typeof queries] = await engine.executeRaw(sql);
    return state;
  } finally { await engine.disconnect(); }
}

function protectedFiles(): string[] {
  return ['.gbrain/config.json', '.gbrain/agent-install/receipt.json', 'memory/nested/note.md', 'memory/attachments/nested/bytes.bin']
    .map(path => sha256(fs.readFileSync(join(root, path))));
}

function expectPrivate(path: string, directory: boolean, protectedAcl = false) {
  if (process.platform !== 'win32') {
    expect(fs.statSync(path).mode & 0o777).toBe(directory ? 0o700 : 0o600);
    return;
  }
  const script = `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:GBRAIN_TEST_ACL_PATH;
$u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; allow=$_.AccessControlType.ToString(); rights=[int]$_.FileSystemRights} });
@{user=$u; owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected=$a.AreAccessRulesProtected; rules=$r} | ConvertTo-Json -Compress -Depth 4`;
  const result = JSON.parse(execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, GBRAIN_TEST_ACL_PATH: path }, encoding: 'utf8', timeout: 15_000, windowsHide: true, input: Buffer.alloc(0), stdio: ['pipe', 'pipe', 'pipe'],
    }));
  expect(result.owner).toBe(result.user);
  if (protectedAcl) expect(result.protected).toBe(true);
  const expectedSids = [...new Set([result.user, 'S-1-5-18'])].sort();
  expect(result.rules.map((rule: { sid: string }) => rule.sid).sort()).toEqual(expectedSids);
  for (const rule of result.rules) {
    expect(rule.allow).toBe('Allow');
    expect(rule.rights).toBe(0x1f01ff);
  }
}

async function expectOriginal() {
  expect(await databaseState(root)).toEqual(original);
  expect(protectedFiles()).toEqual(originalFiles);
  expect(sha256(fs.readFileSync(archive))).toBe(archiveHash);
}

function expectIncomplete(into: string) {
  expect(JSON.parse(fs.readFileSync(join(into, 'restore-receipt.json'), 'utf8'))).toMatchObject({ state: 'failed', original_preserved: true });
  expect(fs.existsSync(join(into, 'bin', 'gbrain'))).toBe(false);
  const stages = fs.readdirSync(into).filter(name => name.startsWith('.restore-'));
  expect(stages).toHaveLength(1);
  expectPrivate(into, true, true);
  expectPrivate(join(into, stages[0]), true);
  const payload = join(into, stages[0], 'payload', 'database.tar');
  if (fs.existsSync(payload)) expectPrivate(payload, false);
}

function rawArchive(file: string, paths: string[]) {
  const manifest = Buffer.from(JSON.stringify({ format_version: 1, entries: paths.map(path => ({ path, size: 0, sha256: sha256('') })) }));
  const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('GBRAIN-BACKUP-1\n'), length, manifest]));
}

beforeAll(async () => {
  temporary = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'gbrain-native-backup-')));
  root = join(temporary, 'original'); archive = join(temporary, 'snapshot.gbrain-backup');
  fs.mkdirSync(join(root, '.gbrain'), { recursive: true, mode: 0o700 });
  for (const path of ['memory/nested', 'memory/attachments/nested', 'instructions/nested']) fs.mkdirSync(join(root, path), { recursive: true });
  const config = { engine: 'pglite', database_path: join(root, '.gbrain', 'brain.pglite'), embedding_disabled: true,
    storage: { backend: 'local', localPath: join(root, 'memory', 'attachments', 'nested') },
    mcp: { skills_dir: join(root, 'instructions', 'nested') }, autopilot: { auto_drain: { enabled: true } } };
  privateWrite(join(root, '.gbrain', 'config.json'), JSON.stringify(config));
  const receipt: AgentInstallReceipt = {
    format_version: 1, installation_id: crypto.randomUUID(), root, harness: 'grok-bot', source_id: 'default',
    database_path: config.database_path, state: 'ready', initialized: true, adopted: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), managed_paths: ['memory', 'instructions'], owned_files: {},
    native: { skill_id: 'fixture-skill', routine_id: 'fixture-routine', verification: 'unverified' }, search_mode_confirmation_required: true,
  };
  privateWrite(join(root, '.gbrain', 'agent-install', 'receipt.json'), JSON.stringify(receipt));
  fs.writeFileSync(join(root, 'memory', 'nested', 'note.md'), `# Fixture\nRemembered text includes ${root}; it must not change.\n`);
  fs.writeFileSync(join(root, 'memory', 'attachments', 'nested', 'bytes.bin'), attachment);
  fs.writeFileSync(join(root, 'instructions', 'nested', 'skill.md'), '# Inactive fixture skill\n');
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: config.database_path });
  try {
    await engine.initSchema();
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default', 'nested', 'external'], async () => {
      await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
      await tx.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [join(root, 'memory')]);
      await tx.executeRaw("INSERT INTO sources (id,name,local_path) VALUES ('nested','Nested fixture',$1),('external','External fixture',$2)", [join(root, 'memory', 'nested'), join(temporary, 'external')]);
      const origins = [join(root, 'memory', 'nested', 'note.md'), 'relative.md', join(temporary, 'outside', 'legacy.md'), 'Z:\\legacy-fixture\\note.md'];
      for (let i = 0; i < origins.length; i++) {
        await tx.executeRaw("INSERT INTO pages (slug,type,title,compiled_truth,content_hash,source_id,source_path) VALUES ($1,'note','Native backup fixture',$2,$3,'nested',$4)", [`fixture-${i}`, `Preserve literal origin ${origins[i]} and root ${root}`, `hash-${i}`, origins[i]]);
      }
      const vector = Array.from({ length: getEmbeddingDimensions() }, (_, i) => i === 0 ? 0.75 : i === 1 ? -0.125 : 0);
      await tx.executeRaw("INSERT INTO content_chunks (page_id,chunk_index,chunk_text,embedding,model,embedded_text_hash,embedded_at) SELECT id,0,compiled_truth,$1::vector,'fixture-model',NULL,'2026-01-01T00:00:00Z' FROM pages WHERE slug IN ('fixture-0','fixture-1')", [JSON.stringify(vector)]);
      await tx.executeRaw("INSERT INTO facts (fact,source,source_id) VALUES ('DB-only backup fixture','fixture','nested')");
      await tx.setConfig('sync.repo_path', join(root, 'memory', 'nested'));
      await tx.setConfig('mcp.skills_dir', join(root, 'instructions', 'nested'));
      await tx.setConfig('connectors.chatgpt.auto_sync', 'true');
    }));
    const queue = new MinionQueue(engine);
    await queue.add('subagent', { fixture: 'unfinished' }, {}, { allowProtectedSubmit: true });
    const completed = await queue.add('subagent', { fixture: 'completed' }, {}, { allowProtectedSubmit: true });
    await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1", [completed.id]);
  } finally { await engine.disconnect(); }
  original = await databaseState(root);
  originalFiles = protectedFiles();
  expect(original.pages).toHaveLength(4);
  expect(original.chunks).toHaveLength(2);
  expect(original.chunks.every(chunk => typeof chunk.vector === 'string' && chunk.vector.length > 100)).toBe(true);
  expect(original.facts).toHaveLength(1);
  expect(original.jobs).toHaveLength(2);
}, 120_000);

afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });

for (const kind of ['directory', 'file'] as const) test.skipIf(process.platform !== 'win32')(`private ${kind} ACL setup uses an explicitly closed input pipe`, () => {
  const observations = [];
  for (const mode of ['baseline', 'candidate', 'candidate', 'baseline'] as const) {
    const path = join(temporary, `closed-input-${kind}-${observations.length} [literal] 'é`);
    if (kind === 'directory') fs.mkdirSync(path);
    else fs.writeFileSync(path, '');
    const before = fs.lstatSync(path, { bigint: true });
    let launches = 0;
    let productionClosedInput = false;
    let bounded = false;
    let nativeError: string | null = null;
    let protectedPath = false;
    const execute = childProcess.execFileSync;
    const inspect = spyOn(childProcess, 'execFileSync').mockImplementation(new Proxy(execute, {
      apply(target, thisArg, args) {
        const options = args[2] as childProcess.ExecFileSyncOptions | undefined;
        if (options?.env?.GBRAIN_BACKUP_PRIVATE_PATH !== path) return Reflect.apply(target, thisArg, args);
        launches++;
        productionClosedInput = Array.isArray(options.stdio) && options.stdio.length === 3 && options.stdio.every(stream => stream === 'pipe')
          && Buffer.isBuffer(options.input) && options.input.length === 0;
        bounded = options.timeout === 15_000 && options.maxBuffer === 64 * 1024 && options.shell === undefined;
        if (mode === 'baseline') args[2] = { ...options, input: undefined, stdio: ['ignore', 'pipe', 'pipe'] };
        try { return Reflect.apply(target, thisArg, args); }
        catch (error) {
          nativeError = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'other';
          throw error;
        }
      },
    }));
    const started = performance.now();
    try { privacy.protectNewBackupPath(path, kind); protectedPath = true; }
    catch (error) { if (!(error instanceof AgentInstallError) || error.code !== 'private_backup_path_unavailable') throw error; }
    finally { inspect.mockRestore(); }
    const after = fs.lstatSync(path, { bigint: true });
    observations.push({ path, mode, elapsedMs: Math.round(performance.now() - started), launches, productionClosedInput, bounded, nativeError, protectedPath,
      sameIdentity: before.dev === after.dev && before.ino === after.ino && before.birthtimeNs === after.birthtimeNs,
      empty: kind === 'directory' ? fs.readdirSync(path).length === 0 : after.size === 0n && after.nlink === 1n });
  }
  process.stderr.write(`Windows backup launch controls: ${JSON.stringify({ kind, arch: process.arch, runtime: Bun.version,
    observations: observations.map(({ path, ...observation }) => observation) })}\n`);
  for (const observation of observations) {
    expect(observation.launches).toBe(1);
    expect(observation.productionClosedInput).toBe(true);
    expect(observation.bounded).toBe(true);
    expect(observation.sameIdentity).toBe(true);
    expect(observation.empty).toBe(true);
    if (observation.mode === 'candidate') {
      expect(observation.protectedPath).toBe(true);
      expect(observation.nativeError).toBeNull();
      expectPrivate(observation.path, kind === 'directory', true);
    }
  }
}, 120_000);

for (const kind of ['directory', 'file'] as const) test.skipIf(process.platform !== 'win32')(`private ${kind} ACL launch completes with asynchronous subprocess collection`, async () => {
  const capturePath = join(temporary, `capture-${kind}`);
  if (kind === 'directory') fs.mkdirSync(capturePath);
  else fs.writeFileSync(capturePath, '');
  let launch: { executable: string; args: string[]; options: childProcess.ExecFileSyncOptionsWithStringEncoding } | undefined;
  let capturedCalls = 0;
  const execute = childProcess.execFileSync;
  const capture = spyOn(childProcess, 'execFileSync').mockImplementation(new Proxy(execute, {
    apply(target, thisArg, args) {
      const options = args[2] as childProcess.ExecFileSyncOptionsWithStringEncoding;
      if (options.env?.GBRAIN_BACKUP_PRIVATE_PATH !== capturePath) return Reflect.apply(target, thisArg, args);
      capturedCalls++;
      launch = { executable: args[0], args: [...args[1]], options: { ...options } };
      throw new Error('captured launch without executing');
    },
  }));
  try { expect(() => privacy.protectNewBackupPath(capturePath, kind)).toThrow(AgentInstallError); }
  finally { capture.mockRestore(); }
  expect(capturedCalls).toBe(1);
  expect(launch !== undefined).toBe(true);
  const captured = launch!;
  expect(captured.executable === join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')).toBe(true);
  expect(captured.options.timeout).toBe(15_000);
  expect(captured.options.maxBuffer).toBe(64 * 1024);
  expect(captured.options.shell).toBeUndefined();
  expect(captured.options.windowsHide).toBe(true);
  expect(Buffer.isBuffer(captured.options.input) && captured.options.input.length === 0).toBe(true);
  expect(Array.isArray(captured.options.stdio) && captured.options.stdio.length === 3 && captured.options.stdio.every(stream => stream === 'pipe')).toBe(true);
  const classify = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ETIMEDOUT' ? 'ETIMEDOUT' : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'MAXBUFFER'
      : code === 'GBRAIN_TEST_COMPLETION_TIMEOUT' ? 'WATCHDOG' : code === 'GBRAIN_TEST_INPUT_FAILURE' ? 'INPUT' : 'other';
  };
  const collect = (args: string[], env: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) => {
    const { input, stdio, ...options } = captured.options;
    let settled = false;
    let watchdog = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, stdout = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(cleanup);
      if (watchdog) error = Object.assign(new Error('asynchronous completion deadline'), { code: 'GBRAIN_TEST_COMPLETION_TIMEOUT' });
      if (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        reject(error);
      } else resolve(stdout);
    };
    const child = childProcess.execFile(captured.executable, args, { ...options, env }, (error, stdout) => {
      finish(error, stdout);
    });
    child.on('error', error => finish(error));
    deadline = setTimeout(() => {
      watchdog = true;
      cleanup = setTimeout(() => finish(new Error('asynchronous termination not confirmed')), 1_000);
      child.kill('SIGKILL');
    }, 15_000);
    const inputFailure = () => finish(Object.assign(new Error('asynchronous input unavailable'), { code: 'GBRAIN_TEST_INPUT_FAILURE' }));
    if (!child.stdin) { inputFailure(); return; }
    child.stdin.on('error', inputFailure);
    try { child.stdin.end(input); }
    catch { inputFailure(); }
  });
  const observations = [];
  for (const mode of ['sync', 'async', 'async', 'sync'] as const) {
    const path = join(temporary, `collection-${kind}-${observations.length} [literal] 'é`);
    if (kind === 'directory') fs.mkdirSync(path);
    else fs.writeFileSync(path, '');
    const before = fs.lstatSync(path, { bigint: true });
    const env = { ...captured.options.env, GBRAIN_BACKUP_PRIVATE_PATH: path };
    let completed = false;
    let nativeError: string | null = null;
    let killed = false;
    const started = performance.now();
    try {
      const result = mode === 'sync' ? execute(captured.executable, captured.args, { ...captured.options, env }) : await collect(captured.args, env);
      completed = result === 'private';
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      nativeError = classify(error);
      killed = failure.killed === true;
    }
    const after = fs.lstatSync(path, { bigint: true });
    observations.push({ path, mode, elapsedMs: Math.round(performance.now() - started), completed, nativeError, killed,
      sameIdentity: before.dev === after.dev && before.ino === after.ino && before.birthtimeNs === after.birthtimeNs,
      empty: kind === 'directory' ? after.isDirectory() && fs.readdirSync(path).length === 0 : after.isFile() && after.size === 0n && after.nlink === 1n,
      privateAcl: false, aclError: null as string | null });
  }
  for (const observation of observations) {
    if (observation.mode !== 'async') continue;
    const script = `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:GBRAIN_TEST_ACL_PATH;
$u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; allow=$_.AccessControlType.ToString(); rights=[int]$_.FileSystemRights; inheritance=[int]$_.InheritanceFlags; propagation=[int]$_.PropagationFlags} });
@{user=$u; owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected=$a.AreAccessRulesProtected; rules=$r} | ConvertTo-Json -Compress -Depth 4`;
    try {
      const actual = JSON.parse(await collect(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { ...captured.options.env, GBRAIN_TEST_ACL_PATH: observation.path }));
      observation.privateAcl = actual.owner === actual.user && actual.protected === true
        && JSON.stringify(actual.rules.map((rule: { sid: string }) => rule.sid).sort()) === JSON.stringify([...new Set([actual.user, 'S-1-5-18'])].sort())
        && actual.rules.every((rule: { inherited: boolean; allow: string; rights: number; inheritance: number; propagation: number }) =>
          !rule.inherited && rule.allow === 'Allow' && rule.rights === 0x1f01ff && rule.inheritance === (kind === 'directory' ? 3 : 0) && rule.propagation === 0);
    } catch (error) { observation.aclError = classify(error); }
  }
  const stagedPath = join(temporary, `staged-${kind} [literal] 'é`);
  const tracePath = join(temporary, `staged-${kind}.trace`);
  if (kind === 'directory') fs.mkdirSync(stagedPath);
  else fs.writeFileSync(stagedPath, '');
  const stagedBefore = fs.lstatSync(stagedPath, { bigint: true });
  fs.writeFileSync(tracePath, '', { flag: 'wx', mode: 0o600 });
  const trace = (stage: string) => `[IO.File]::AppendAllText($env:GBRAIN_TEST_ACL_STAGE, '${stage}' + [Environment]::NewLine)`;
  const checkpoints = [
    ["$ErrorActionPreference = 'Stop'", 'entry'],
    ['$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User', 'identity'],
    ['$item = Get-Item -LiteralPath $path -Force', 'item'],
    ['Set-Acl -LiteralPath $path -AclObject $acl', 'after-set'],
    ['$actual = Get-Acl -LiteralPath $path', 'read-back'],
  ] as const;
  expect(captured.args.at(-2) === '-EncodedCommand').toBe(true);
  let stagedProgram = Buffer.from(captured.args.at(-1)!, 'base64').toString('utf16le');
  for (const [line, stage] of checkpoints) {
    expect(stagedProgram.split(line).length).toBe(2);
    stagedProgram = stagedProgram.replace(line, `${stage === 'after-set' ? trace('before-set') + '\n' : ''}${line}\n${trace(stage)}`);
  }
  expect(stagedProgram.split("[Console]::Write('private')").length).toBe(2);
  stagedProgram = stagedProgram.replace("[Console]::Write('private')", `${trace('verified')}\n[Console]::Write('private')\n${trace('output-write-returned')}`);
  let stagedCompleted = false;
  let stagedError: string | null = null;
  const stagedStarted = performance.now();
  try {
    stagedCompleted = execute(captured.executable, [...captured.args.slice(0, -1), Buffer.from(stagedProgram, 'utf16le').toString('base64')],
      { ...captured.options, env: { ...captured.options.env, GBRAIN_BACKUP_PRIVATE_PATH: stagedPath, GBRAIN_TEST_ACL_STAGE: tracePath } }) === 'private';
  } catch (error) { stagedError = classify(error); }
  const stagedElapsedMs = Math.round(performance.now() - stagedStarted);
  const stagedAfter = fs.lstatSync(stagedPath, { bigint: true });
  const stagedSameIdentity = stagedBefore.dev === stagedAfter.dev && stagedBefore.ino === stagedAfter.ino && stagedBefore.birthtimeNs === stagedAfter.birthtimeNs;
  const stagedEmpty = kind === 'directory' ? stagedAfter.isDirectory() && fs.readdirSync(stagedPath).length === 0
    : stagedAfter.isFile() && stagedAfter.size === 0n && stagedAfter.nlink === 1n;
  const allowedStages = ['entry', 'identity', 'item', 'before-set', 'after-set', 'read-back', 'verified', 'output-write-returned'];
  const traceBytes = fs.readFileSync(tracePath);
  const recordedStages = traceBytes.length <= 128 ? traceBytes.toString('utf8').split(/\r?\n/).filter(Boolean) : [];
  const validTrace = traceBytes.length <= 128 && recordedStages.every(stage => allowedStages.includes(stage))
    && JSON.stringify(recordedStages) === JSON.stringify(allowedStages.slice(0, recordedStages.length));
  let sameResolvedExecutable: boolean | null = null;
  try {
    const resolved = Bun.which('powershell.exe');
    if (resolved) {
      const a = fs.statSync(resolved, { bigint: true }), b = fs.statSync(captured.executable, { bigint: true });
      if (a.ino && b.ino) sameResolvedExecutable = a.dev === b.dev && a.ino === b.ino;
    }
  } catch {}
  process.stderr.write(`Windows backup collection controls: ${JSON.stringify({ kind, arch: process.arch, runtime: Bun.version,
    observations: observations.map(({ path, ...observation }) => observation),
    staged: { elapsedMs: stagedElapsedMs, completed: stagedCompleted, nativeError: stagedError, sameIdentity: stagedSameIdentity, empty: stagedEmpty,
      validTrace, stages: validTrace ? recordedStages : [], sameResolvedExecutable } })}\n`);
  expect(validTrace).toBe(true);
  expect(stagedSameIdentity).toBe(true);
  expect(stagedEmpty).toBe(true);
  if (stagedCompleted) expect(recordedStages).toEqual(allowedStages);
  for (const observation of observations) {
    expect(observation.sameIdentity).toBe(true);
    expect(observation.empty).toBe(true);
    if (observation.mode !== 'async') continue;
    expect(observation.completed).toBe(true);
    expect(observation.nativeError).toBeNull();
    expect(observation.privateAcl).toBe(true);
    expect(observation.aclError).toBeNull();
  }
}, 120_000);

test('native create, verify, absent-root restore and fresh-process reopen preserve exact data and nested paths', async () => {
  const protect = privacy.protectNewBackupPath;
  const protectedKinds: string[] = [];
  const inspected = spyOn(privacy, 'protectNewBackupPath').mockImplementation((path, kind) => {
    protect(path, kind);
    expectPrivate(path, kind === 'directory', true);
    protectedKinds.push(kind);
  });
  let created: Awaited<ReturnType<typeof createPgliteBackup>>;
  try { created = await createPgliteBackup({ root, output: archive }); }
  finally { inspected.mockRestore(); }
  expect(protectedKinds).toEqual(['directory', 'file']);
  archiveHash = sha256(fs.readFileSync(archive));
  expectPrivate(archive, false, true);
  expect(created.manifest.entries.length).toBeGreaterThanOrEqual(5);
  expect(created.manifest.entries.every(entry => !entry.path.includes('\\'))).toBe(true);
  expect(created.manifest.sources).toContainEqual({ id: 'nested', local_path: join(root, 'memory', 'nested'), managed_relative_path: 'memory/nested' });
  const verified = join(temporary, 'verified'); fs.mkdirSync(verified, { mode: 0o700 });
  expect(readBackupArchive(archive, verified)).toEqual(created.manifest);
  expect(fs.readFileSync(join(verified, 'files', 'memory', 'attachments', 'nested', 'bytes.bin'))).toEqual(attachment);
  const cluster = join(temporary, 'cluster'); fs.mkdirSync(cluster, { mode: 0o700 });
  extractPgliteDump(join(verified, 'database.tar'), cluster);
  for (const directory of emptyDirectories) expect(fs.readdirSync(join(cluster, directory))).toEqual([]);
  const into = join(temporary, 'restored'); expect(fs.existsSync(into)).toBe(false);
  const result = await restorePgliteBackup({ archive, into });
  expectPrivate(into, true, true);
  expectPrivate(join(into, '.gbrain', 'brain.pglite', 'PG_VERSION'), false);
  expect(result.quarantined_jobs).toBe(1);
  expect(result.reconnect_required.some(line => line.includes('2 legacy absolute page origins were preserved unchanged'))).toBe(true);
  const program = `import {PGLiteEngine} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src/core/pglite-engine.ts')).href)};
const engine = new PGLiteEngine(); await engine.connectForRestore({engine:'pglite',database_path:${JSON.stringify(join(into, '.gbrain', 'brain.pglite'))}});
try { const state = {}; for (const [key, sql] of Object.entries(${JSON.stringify(queries)})) state[key] = await engine.executeRaw(sql); console.log(JSON.stringify(state)); } finally { await engine.disconnect(); }`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', program], { cwd: temporary, env: { ...process.env, GBRAIN_HOME: into }, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 45_000);
  let reopened: typeof original;
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
    reopened = JSON.parse(stdout);
  } finally { clearTimeout(timer); }
  expect(reopened.pages).toHaveLength(4);
  expect(reopened.pages).toEqual(original.pages.map(page => page.slug === 'fixture-0' ? { ...page, source_path: join(into, 'memory', 'nested', 'note.md') } : page));
  expect(reopened.chunks).toHaveLength(2);
  expect(reopened.chunks).toEqual(original.chunks);
  expect(reopened.facts).toEqual(original.facts);
  expect(reopened.sources.find(source => source.id === 'nested')?.local_path).toBe(join(into, 'memory', 'nested'));
  expect(reopened.sources.find(source => source.id === 'external')?.local_path).toBeNull();
  expect(reopened.jobs).toHaveLength(2);
  expect(reopened.jobs[0]).toMatchObject({ status: 'cancelled', lock_token: null, lock_until: null, data: { __restore_previous_status: 'waiting' } });
  expect(reopened.jobs[1]).toEqual(original.jobs[1]);
  expect(reopened.settings).toEqual([{ key: 'connectors.chatgpt.auto_sync', value: 'false' }, { key: 'mcp.skills_dir', value: join(into, 'instructions', 'nested') }, { key: 'sync.repo_path', value: join(into, 'memory', 'nested') }]);
  const config = JSON.parse(fs.readFileSync(join(into, '.gbrain', 'config.json'), 'utf8'));
  expect(config.storage.localPath).toBe(join(into, 'memory', 'attachments', 'nested'));
  expect(config.mcp.skills_dir).toBe(join(into, 'instructions', 'nested'));
  expect(config.autopilot.auto_drain.enabled).toBe(false);
  expect(fs.readFileSync(join(config.storage.localPath, 'bytes.bin'))).toEqual(attachment);
  expectPrivate(join(config.storage.localPath, 'bytes.bin'), false);
  expect(fs.readFileSync(join(into, 'memory', 'nested', 'note.md'))).toEqual(fs.readFileSync(join(root, 'memory', 'nested', 'note.md')));
  for (const directory of emptyDirectories) expect(fs.readdirSync(join(into, '.gbrain', 'brain.pglite', directory))).toEqual([]);
  expect(readInstallReceipt(into)).toMatchObject({ state: 'installing', native: { verification: 'unverified' } });
  expect(fs.existsSync(join(into, '.gbrain', 'autopilot-paused'))).toBe(true);
  expect(fs.existsSync(join(into, 'bin', 'gbrain'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(join(into, 'restore-receipt.json'), 'utf8'))).toMatchObject({ state: 'ready', launcher_ready: false, setup_required: true, native_automation_started: false });
  await expectOriginal();
}, 120_000);

test('recorded Windows and POSIX path semantics rebase only provably managed paths', () => {
  for (const [originalRoot, nested] of [['C:\\old\\brain', 'C:\\old\\brain\\memory\\nested'], ['/old/brain', '/old/brain/memory/nested']]) {
    expect(relativeBackupPath(originalRoot, nested)).toBe('memory/nested');
    expect(rebaseRestorePath(nested, originalRoot, root, ['memory'])).toBe(join(root, 'memory', 'nested'));
    expect(rebaseManagedConfig({ engine: 'pglite', mcp: { skills_dir: nested } }, originalRoot, root, ['memory'], []).mcp?.skills_dir).toBe(join(root, 'memory', 'nested'));
  }
  for (const value of ['C:memory\\nested', '\\memory\\nested', 'D:\\old\\brain\\memory\\nested', 'C:\\old\\brain\\memory\\..\\outside']) expect(relativeBackupPath('C:\\old\\brain', value)).toBeNull();
  expect(relativeBackupPath('/old/brain', '/old/brain/memory/literal\\name')).toBeNull();
  expect(rebaseRestorePath('/old/brain/memory-other/note', '/old/brain', root, ['memory'])).toBeNull();
  expect(confinedPath(root + '/', 'memory/nested')).toBe(join(root, 'memory', 'nested'));
  expect(() => confinedPath('relative-root', 'memory/nested')).toThrow('absolute');
  expect(() => confinedPath(join(root, 'memory') + '/../instructions', 'nested')).toThrow('traversal');
});

test('portable manifests reject traversal, absolute names and Windows aliases before extraction', () => {
  const into = join(temporary, 'unsafe-entries'); fs.mkdirSync(into);
  const input = join(root, 'memory', 'nested', 'note.md');
  for (const name of ['../escape', '/absolute', 'C:/absolute', 'C:relative', '//server/share', '\\\\server\\share', 'a\\b', 'a//b', './a', 'a/../b', 'a/./b', 'a/', 'a\0b', 'a\nb', 'a:stream', 'a.', 'a ', 'CON', 'nul.txt', 'com1', 'LPT9.log', 'x/aux', 'conin$', 'conout$.txt', 'CON .txt', 'a?b', 'a*b']) {
    const bad = join(temporary, 'bad-entry'); rawArchive(bad, [name]);
    expect(() => readBackupArchive(bad, into)).toThrow();
    expect(fs.readdirSync(into)).toEqual([]);
    expect(() => writeBackupArchive(join(temporary, 'bad-output'), {}, [{ path: name, file: input }])).toThrow();
    expect(fs.existsSync(join(temporary, 'bad-output'))).toBe(false);
  }
  expect(() => checkedManagedPaths(null, ['Memory', 'memory/nested'])).toThrow();
  expect(() => checkedManagedPaths(null, ['.GBRAIN/private'])).toThrow();
});

test('duplicate, case, normalization and file-directory collisions fail before extraction', () => {
  for (const names of [['a', 'a'], ['a', 'A'], ['a', 'a/b'], ['a/b', 'a'], ['Memory/a', 'memory/b'], ['caf\u00e9/a', 'cafe\u0301/b']]) {
    const bad = join(temporary, 'colliding-entry'); rawArchive(bad, names);
    const into = fs.mkdtempSync(join(temporary, 'collision-'));
    expect(() => readBackupArchive(bad, into)).toThrow('conflicting');
    expect(fs.readdirSync(into)).toEqual([]);
  }
});

test('a colliding restore inventory preserves its archive and never publishes ready', async () => {
  const bad = join(temporary, 'duplicate.gbrain-backup'); rawArchive(bad, ['memory/a', 'Memory/b']);
  const hash = sha256(fs.readFileSync(bad));
  const into = join(temporary, 'duplicate-restore');
  await expect(restorePgliteBackup({ archive: bad, into })).rejects.toThrow('conflicting');
  expectIncomplete(into);
  expect(sha256(fs.readFileSync(bad))).toBe(hash);
  expect(fs.existsSync(join(into, '.gbrain'))).toBe(false);
  await expectOriginal();
});

for (const kind of ['corrupt', 'truncated'] as const) test(`${kind} archive preserves originals and never publishes ready`, async () => {
  const bytes = fs.readFileSync(archive);
  const bad = join(temporary, kind + '.gbrain-backup');
  if (kind === 'corrupt') bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(bad, kind === 'corrupt' ? bytes : bytes.subarray(0, bytes.length - 1));
  const hash = sha256(fs.readFileSync(bad));
  const into = join(temporary, kind + '-restore');
  await expect(restorePgliteBackup({ archive: bad, into })).rejects.toThrow(kind === 'corrupt' ? 'checksum' : 'length');
  expectIncomplete(into);
  expect(fs.existsSync(join(into, '.gbrain'))).toBe(false);
  expect(sha256(fs.readFileSync(bad))).toBe(hash);
  await expectOriginal();
});

test('an existing restore destination is never overwritten', async () => {
  await expect(restorePgliteBackup({ archive, into: root })).rejects.toMatchObject({ code: 'restore_target_exists' });
  await expectOriginal();
});

test('a live locked store refuses backup without removing its lease', async () => {
  const lock = await acquireLock(join(root, '.gbrain', 'brain.pglite'));
  const lockPath = join(lock.lockDir!, 'lock');
  const lease = { ...JSON.parse(fs.readFileSync(lockPath, 'utf8')), subcommand: 'serve' };
  fs.writeFileSync(lockPath, JSON.stringify(lease));
  const output = join(temporary, 'busy-backup');
  try {
    await expect(createPgliteBackup({ root, output })).rejects.toMatchObject({ code: 'pglite_busy' });
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual(lease);
    expect(fs.existsSync(output)).toBe(false);
  } finally { await releaseLock(lock); }
  await expectOriginal();
});

test('symlinks or Windows junctions cannot redirect extraction or managed backup inputs', async () => {
  const outside = join(temporary, 'link-target'); fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, 'sentinel'), 'unchanged');
  const link = join(root, 'memory', 'redirect');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await expect(createPgliteBackup({ root, output: join(temporary, 'linked-backup') })).rejects.toMatchObject({ code: 'symlink_path' });
    await expect(restorePgliteBackup({ archive, into: join(link, 'restore') })).rejects.toMatchObject({ code: 'symlink_path' });
    const input = join(temporary, 'linked-extract'); rawArchive(input, ['redirect/escaped']);
    expect(() => readBackupArchive(input, join(root, 'memory'))).toThrow('symlink');
    expect(fs.readdirSync(outside)).toEqual(['sentinel']);
    expect(fs.readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
  } finally { fs.unlinkSync(link); }
  await expectOriginal();
});

for (const boundary of ['file-fsync', 'publication'] as const) test(`unexpected ${boundary} I/O failure retains private staging, originals and no ready receipt`, async () => {
  const into = join(temporary, boundary + '-failure');
  let injected = false;
  const fsync = fs.fsyncSync; const rename = fs.renameSync;
  const fault = boundary === 'file-fsync'
    ? spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (!injected && fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size > 1_000_000) {
        injected = true; throw Object.assign(new Error('injected file I/O failure'), { code: 'EIO' });
      }
      fsync(fd);
    })
    : spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === join(into, 'memory')) { injected = true; throw Object.assign(new Error('injected publication I/O failure'), { code: 'EIO' }); }
      rename(from, to);
    });
  try { await expect(restorePgliteBackup({ archive, into })).rejects.toMatchObject({ code: 'EIO' }); }
  finally { fault.mockRestore(); }
  expect(injected).toBe(true);
  expectIncomplete(into);
  await expect(restorePgliteBackup({ archive, into })).rejects.toMatchObject({ code: 'restore_target_exists' });
  await expectOriginal();
});

for (const boundary of ['backup-directory', 'restore-root', 'archive-file'] as const) test(`unavailable ${boundary} privacy refuses before payload bytes or ready state`, async () => {
  const into = join(temporary, boundary + '-privacy');
  const output = join(temporary, boundary + '-archive');
  const protect = privacy.protectNewBackupPath;
  let refused = false;
  const fault = spyOn(privacy, 'protectNewBackupPath').mockImplementation((path, kind) => {
    if (boundary === 'restore-root' ? path === into : boundary === 'archive-file' ? kind === 'file' : kind === 'directory') {
      expect(kind === 'directory' ? fs.readdirSync(path) : fs.readFileSync(path)).toEqual(kind === 'directory' ? [] : Buffer.alloc(0));
      refused = true;
      if (process.platform === 'win32') {
        const systemRoot = process.env.SystemRoot;
        process.env.SystemRoot = join(temporary, 'unavailable-windows-tools');
        try { return protect(path, kind); }
        finally {
          if (systemRoot === undefined) delete process.env.SystemRoot;
          else process.env.SystemRoot = systemRoot;
        }
      }
      throw new AgentInstallError('private_backup_path_unavailable', 'injected unavailable Windows privacy enforcement');
    }
    protect(path, kind);
  });
  try {
    await expect(boundary === 'restore-root' ? restorePgliteBackup({ archive, into }) : createPgliteBackup({ root, output })).rejects.toMatchObject({ code: 'private_backup_path_unavailable' });
  } finally { fault.mockRestore(); }
  expect(refused).toBe(true);
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.readdirSync(temporary).some(name => name.includes('.partial-') || name.startsWith('.gbrain-backup-'))).toBe(false);
  if (boundary === 'restore-root') expect(fs.readdirSync(into)).toEqual([]);
  await expectOriginal();
});

test('backup paths exclude inherited public access without changing the existing parent', async () => {
  const parent = join(temporary, 'public-parent'); fs.mkdirSync(parent);
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const inspectParent = () => process.platform === 'win32'
    ? execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:GBRAIN_TEST_ACL_PATH).Sddl'], {
      env: { ...process.env, GBRAIN_TEST_ACL_PATH: parent }, encoding: 'utf8', timeout: 15_000, windowsHide: true, input: Buffer.alloc(0), stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() : fs.statSync(parent).mode;
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:GBRAIN_TEST_ACL_PATH;
$r=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);
$a.AddAccessRule($r); Set-Acl -LiteralPath $env:GBRAIN_TEST_ACL_PATH -AclObject $a`;
    execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, GBRAIN_TEST_ACL_PATH: parent }, timeout: 15_000, windowsHide: true, input: Buffer.alloc(0), stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else fs.chmodSync(parent, 0o777);
  const before = inspectParent();
  const output = join(parent, 'snapshot.gbrain-backup');
  const protect = privacy.protectNewBackupPath;
  const inspected = spyOn(privacy, 'protectNewBackupPath').mockImplementation((path, kind) => {
    protect(path, kind); expectPrivate(path, kind === 'directory', true);
  });
  try { await createPgliteBackup({ root, output }); }
  finally { inspected.mockRestore(); }
  expectPrivate(output, false, true);
  const into = join(parent, 'retained-failure');
  const rename = fs.renameSync;
  let interrupted = false;
  const fault = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    rename(from, to);
    if (String(to) === join(into, '.gbrain')) {
      interrupted = true;
      throw new Error('injected public-parent restore interruption');
    }
  });
  try { await expect(restorePgliteBackup({ archive: output, into })).rejects.toThrow('injected public-parent restore interruption'); }
  finally { fault.mockRestore(); }
  expect(interrupted).toBe(true);
  expectIncomplete(into);
  expectPrivate(join(into, '.gbrain', 'brain.pglite', 'PG_VERSION'), false);
  expect(fs.readFileSync(join(into, '.gbrain', 'brain.pglite', 'PG_VERSION'), 'utf8').trim()).toBe('17');
  const [stage] = fs.readdirSync(into).filter(name => name.startsWith('.restore-'));
  expectPrivate(join(into, stage, 'payload', 'database.tar'), false);
  expect(fs.statSync(join(into, stage, 'payload', 'database.tar')).size).toBeGreaterThan(0);
  expect(inspectParent()).toBe(before);
  await expectOriginal();
}, 120_000);

for (const failureCode of [null, 'EPERM', 'EIO'] as const) test(failureCode
  ? `restore preserves private staging when a writable file flush fails with ${failureCode}`
  : 'restore honors a simulated Windows writable-handle file-flush requirement', async () => {
  const into = join(temporary, `writable-flush-${failureCode ?? 'success'}`);
  const open = fs.openSync; const fsync = fs.fsyncSync; const close = fs.closeSync;
  const handles = new Map<number, string>();
  const flagsSeen: string[] = [];
  let versionPath = '';
  let flushes = 0;
  let closes = 0;
  const flushError = failureCode ? Object.assign(new Error('injected restored writable-file flush failure'), { code: failureCode }) : null;
  const opened = spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    const fd = open(path, flags, mode);
    if (String(path).startsWith(join(into, '.restore-')) && String(path).endsWith(join('restored', '.gbrain', 'brain.pglite', 'PG_VERSION')) && (flags === 'r' || flags === 'r+')) {
      versionPath = String(path);
      handles.set(fd, flags);
      flagsSeen.push(flags);
    }
    return fd;
  });
  const synced = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (handles.has(fd)) {
      flushes++;
      if (handles.get(fd) === 'r') throw Object.assign(new Error('simulated Windows read-only file flush refusal'), { code: 'EPERM' });
      if (flushError) throw flushError;
    }
    fsync(fd);
  });
  const closed = spyOn(fs, 'closeSync').mockImplementation(fd => {
    close(fd);
    if (handles.delete(fd)) closes++;
  });
  try {
    if (flushError) await expect(restorePgliteBackup({ archive, into })).rejects.toBe(flushError);
    else expect((await restorePgliteBackup({ archive, into })).root).toBe(into);
  } finally { opened.mockRestore(); synced.mockRestore(); closed.mockRestore(); }
  expect(flagsSeen).toEqual(['r+']);
  expect(flushes).toBe(1);
  expect(closes).toBe(1);
  if (flushError) {
    expectIncomplete(into);
    expect(fs.existsSync(join(into, '.gbrain'))).toBe(false);
    expectPrivate(versionPath, false);
    expect(fs.readFileSync(versionPath, 'utf8').trim()).toBe('17');
    const [stage] = fs.readdirSync(into).filter(name => name.startsWith('.restore-'));
    expectPrivate(join(into, stage, 'payload', 'database.tar'), false);
    expect(fs.statSync(join(into, stage, 'payload', 'database.tar')).size).toBeGreaterThan(0);
  } else {
    expect(JSON.parse(fs.readFileSync(join(into, 'restore-receipt.json'), 'utf8')).state).toBe('ready');
    expectPrivate(join(into, '.gbrain', 'brain.pglite', 'PG_VERSION'), false);
    expect(fs.readFileSync(join(into, '.gbrain', 'brain.pglite', 'PG_VERSION'), 'utf8').trim()).toBe('17');
    expect(fs.readFileSync(join(into, 'memory', 'nested', 'note.md'))).toEqual(fs.readFileSync(join(root, 'memory', 'nested', 'note.md')));
    expect(fs.readFileSync(join(into, 'memory', 'attachments', 'nested', 'bytes.bin'))).toEqual(attachment);
    expect((await databaseState(into)).facts).toEqual(original.facts);
  }
  await expectOriginal();
}, 120_000);
