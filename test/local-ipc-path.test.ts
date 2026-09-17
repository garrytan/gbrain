import { afterEach, describe, expect, test } from 'bun:test';
import net, { type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { claimLocalIpcBinding, localIpcSocketPath, prepareLocalIpcPath, UNIX_SOCKET_PATH_MAX_BYTES } from '../src/core/context/ipc-path.ts';
import { ipcSecretPathForConfig, resolveSocketPathForConfig, resolveViaIpc, socketHasLiveListener, startResolveIpcServer } from '../src/core/context/resolve-ipc.ts';
import { persistenceSocketPathForConfig, requestPersistenceCapabilities, requestPersistenceOperation, startPersistenceIpcServer } from '../src/core/persistence/ipc.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';
import { windowsPipeName } from '../src/core/context/windows-ipc.ts';
import { tryAcquireNativeIpcMutex } from '../src/core/persistence/native-lock.ts';

const BRAIN = '10000000-0000-4000-8000-000000000001';
const ID = '20000000-0000-4000-8000-000000000001';
const request = { version: 1 as const, kind: 'operation' as const, brain_id: BRAIN, operation: 'put_page' as const,
  params: { slug: 'example/page', content: 'kept', request_id: ID },
  registration: { id: '30000000-0000-4000-8000-000000000001', credential: 'a'.repeat(64), lane: 'cli' as const },
  routing: { source: 'client-source', cwd: tmpdir() } };
const dirs = new Set<string>(), servers = new Set<Server>(), sockets = new Set<Socket>();
const children: Bun.Subprocess<'pipe', 'pipe', 'pipe'>[] = [];
function temporary(short = false) { const path = mkdtempSync(join(short && process.platform !== 'win32' ? (process.platform === 'darwin' ? '/private/tmp' : '/tmp') : tmpdir(), 'gb-ipc-path-')); dirs.add(path); return path; }
function longPath(name = '.gbrain-persistence.sock') {
  const path = join(temporary(), '界'.repeat(45), 'brain.pglite', name);
  const selected = localIpcSocketPath(path); dirs.add(dirname(selected)); return path;
}
function track(server: Server | null) { expect(server).not.toBeNull(); servers.add(server!); return server!; }
async function connect(path: string) {
  const socket = net.createConnection(path); sockets.add(socket); await once(socket, 'connect'); return socket;
}
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill(9); await child.exited; }
  for (const socket of sockets) socket.destroy(); sockets.clear();
  for (const server of servers) {
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
  }
  servers.clear();
  for (const path of dirs) rmSync(path, { recursive: true, force: true }); dirs.clear();
});

describe.skipIf(process.platform === 'win32')('portable private Unix IPC', () => {
  test('keeps ordinary addresses and applies the byte budget separately to each role', () => {
    const root = realpathSync(temporary(true));
    const length = UNIX_SOCKET_PATH_MAX_BYTES - Buffer.byteLength(join(root, '.gbrain-resolve.sock')) - 1;
    const database_path = join(root, 'x'.repeat(length));
    const legacyResolve = join(database_path, '.gbrain-resolve.sock');
    expect(Buffer.byteLength(legacyResolve)).toBe(UNIX_SOCKET_PATH_MAX_BYTES);
    expect(resolveSocketPathForConfig({ engine: 'pglite', database_path })).toBe(legacyResolve);
    const persistence = persistenceSocketPathForConfig({ engine: 'pglite', database_path })!;
    expect(persistence).not.toBe(join(database_path, '.gbrain-persistence.sock'));
    expect(Buffer.byteLength(persistence)).toBeLessThanOrEqual(UNIX_SOCKET_PATH_MAX_BYTES);
    expect(existsSync(dirname(persistence))).toBe(false);
  });

  test('UTF8, long HOME/TMPDIR, physical aliases and both discovery clients select the same private address', async () => {
    const path = longPath(); const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const alias = join(temporary(), 'alias'); symlinkSync(directory, alias);
    const selected = localIpcSocketPath(path);
    expect(Buffer.byteLength(path)).toBeGreaterThan(UNIX_SOCKET_PATH_MAX_BYTES);
    expect(localIpcSocketPath(join(alias, '.gbrain-persistence.sock'))).toBe(selected);
    expect(localIpcSocketPath(selected)).toBe(selected);
    const cfg = { engine: 'pglite' as const, database_path: directory };
    expect(persistenceSocketPathForConfig(cfg)).toBe(selected);
    const resolvePath = resolveSocketPathForConfig(cfg)!;
    expect(resolvePath).not.toBe(selected);
    expect(ipcSecretPathForConfig(cfg)).toBe(join(directory, '.gbrain-ipc-secret'));
    await withEnv({ HOME: directory, GBRAIN_HOME: directory, TMPDIR: join(directory, 'temporary') }, async () => {
      expect(localIpcSocketPath(path)).toBe(selected);
      const pg = { engine: 'postgres' as const, database_url: 'postgresql://example:fixture-secret@host.invalid/brain' };
      const first = resolveSocketPathForConfig(pg)!;
      const second = persistenceSocketPathForConfig(pg)!;
      expect(first).not.toBe(second);
      for (const value of [first, second]) {
        expect(Buffer.byteLength(value)).toBeLessThanOrEqual(UNIX_SOCKET_PATH_MAX_BYTES);
        expect(value).not.toContain('fixture-secret');
        expect(existsSync(dirname(value))).toBe(false);
      }
      expect(ipcSecretPathForConfig(pg)).toContain(directory);
    });
    expect(existsSync(dirname(selected))).toBe(false);
    const binding = await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async received => received });
    track(binding?.server ?? null);
    expect(binding!.socketPath).toBe(selected);
    expect(statSync(dirname(selected)).mode & 0o777).toBe(0o700);
    expect(statSync(selected).mode & 0o777).toBe(0o600);
    expect((await requestPersistenceCapabilities(path)).brain_id).toBe(BRAIN);
    expect(await requestPersistenceOperation(join(alias, '.gbrain-persistence.sock'), request)).toEqual(request);
    expect(await socketHasLiveListener(path)).toBe(true);
  });

  for (const role of ['resolve', 'persistence'] as const) {
    test(`${role}: simultaneous processes elect one provider and SIGKILL permits safe stale takeover`, async () => {
      const path = longPath(`.gbrain-${role}.sock`), selected = localIpcSocketPath(path);
      const root = temporary(), start = join(root, 'start'), fixture = resolve(import.meta.dir, 'fixtures/local-ipc-process.ts');
      const results = [join(root, 'a'), join(root, 'b')];
      const pair = results.map(result => {
        const child = Bun.spawn([process.execPath, '--no-env-file', fixture, path, result, start, role], {
          stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH },
        }); children.push(child); return child;
      });
      await waitFor(() => results.every(result => existsSync(`${result}.ready`)), { timeoutMs: 15000 });
      writeFileSync(start, 'start');
      await waitFor(() => results.every(existsSync) || pair.some(child => child.exitCode !== null && child.exitCode !== 0), { timeoutMs: 15000 });
      for (let i = 0; i < pair.length; i++) if (!existsSync(results[i])) throw new Error(await new Response(pair[i].stderr).text());
      const outcomes = results.map(result => readFileSync(result, 'utf8'));
      expect([...outcomes].sort()).toEqual(['bound', 'busy']);
      const winner = outcomes.indexOf('bound'), inode = statSync(selected).ino;
      expect(await claimLocalIpcBinding(path)).toBeNull();
      if (role === 'resolve') {
        expect(await startResolveIpcServer(path, async () => null)).toBeNull();
        expect(await resolveViaIpc(path, { candidates: [] })).toEqual({ pointers: [], text: results[winner] });
      } else {
        expect(await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) })).toBeNull();
        expect(await requestPersistenceOperation(path, request)).toEqual({ owner: results[winner] });
      }
      expect(statSync(selected).ino).toBe(inode);
      pair[winner].kill(9); await pair[winner].exited;
      expect(existsSync(selected)).toBe(true); // The actual killed process left its socket behind.
      chmodSync(selected, 0o755); // A crash may precede the readiness chmod.
      expect(await socketHasLiveListener(path)).toBe(false);
      if (role === 'resolve') track(await startResolveIpcServer(path, async () => ({ pointers: [], text: 'successor' })));
      else track((await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) }))?.server ?? null);
      expect(await socketHasLiveListener(path)).toBe(true);
      expect(statSync(selected).mode & 0o777).toBe(0o600);
    });

    test(`${role}: the native binding remains held until an accepted connection actually closes`, async () => {
      const path = longPath(`.gbrain-${role}.sock`), selected = localIpcSocketPath(path);
      const server = track(role === 'resolve' ? await startResolveIpcServer(path, async () => null)
        : (await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) }))?.server ?? null);
      const accepted = once(server, 'connection');
      const socket = await connect(selected); const [peer] = await accepted; sockets.add(peer);
      const closed = new Promise<void>(done => server.once('close', done));
      server.close();
      if (role === 'resolve') server.emit('error', Object.assign(new Error('closing fixture'), { code: 'EIO' }));
      expect(server.listening).toBe(false);
      expect(await claimLocalIpcBinding(path)).toBeNull();
      socket.destroy(); peer.destroy(); await closed;
      const next = await claimLocalIpcBinding(path); expect(next).not.toBeNull(); await next!.release();
    });
  }

  test('inaccessible older listeners are preserved, including their inode', async () => {
    const path = join(realpathSync(temporary(true)), 'old.sock');
    const server = track(net.createServer(socket => socket.end('old-owner')));
    server.listen(path); await once(server, 'listening');
    const inode = statSync(path).ino;
    chmodSync(path, 0o000);
    expect(await socketHasLiveListener(path)).toBe(true);
    expect(await startResolveIpcServer(path, async () => null)).toBeNull();
    expect(await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) })).toBeNull();
    expect(statSync(path).ino).toBe(inode);
    chmodSync(path, 0o600);
    const socket = net.createConnection(path); sockets.add(socket);
    expect((await once(socket, 'data'))[0].toString()).toBe('old-owner');
  });

  test('squatted or symlinked fallback directories fail closed without repairing permissions', async () => {
    for (const kind of ['mode', 'symlink', 'file']) {
      const path = longPath(), selected = localIpcSocketPath(path), parent = dirname(selected);
      if (kind === 'mode') { mkdirSync(parent, { mode: 0o755 }); chmodSync(parent, 0o755); }
      else if (kind === 'symlink') symlinkSync(temporary(), parent);
      else writeFileSync(parent, 'preserve');
      expect(() => prepareLocalIpcPath(path)).toThrow('Unsafe private directory');
      expect(await startResolveIpcServer(path, async () => null)).toBeNull();
      await expect(startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) })).rejects.toThrow();
      await expect(requestPersistenceOperation(path, request)).rejects.toMatchObject({ sent: false, requestId: ID });
      if (kind === 'mode') expect(lstatSync(parent).mode & 0o777).toBe(0o755);
      if (kind === 'symlink') expect(lstatSync(parent).isSymbolicLink()).toBe(true);
      if (kind === 'file') expect(readFileSync(parent, 'utf8')).toBe('preserve');
    }
  });

  test('fallback socket symlinks and regular files are never removed or contacted', async () => {
    for (const kind of ['symlink', 'file']) {
      const path = longPath(), selected = prepareLocalIpcPath(path, true), target = join(temporary(), 'keep');
      writeFileSync(target, 'kept');
      if (kind === 'symlink') symlinkSync(target, selected); else writeFileSync(selected, 'kept');
      await expect(startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) })).rejects.toThrow('Unsafe local IPC socket');
      await expect(requestPersistenceOperation(path, request)).rejects.toMatchObject({ sent: false, requestId: ID });
      expect(readFileSync(target, 'utf8')).toBe('kept');
      expect(lstatSync(selected).isSymbolicLink()).toBe(kind === 'symlink');
    }
  });

  test('clients send no credentials through an unsafe socket mode; native lock symlinks refuse binding', async () => {
    const path = longPath(), selected = localIpcSocketPath(path); let dispatches = 0;
    const binding = await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => { dispatches++; return {}; } });
    track(binding?.server ?? null);
    chmodSync(selected, 0o666);
    await expect(requestPersistenceOperation(path, request)).rejects.toMatchObject({ sent: false, requestId: ID });
    expect(dispatches).toBe(0);
    chmodSync(selected, 0o600);
    const other = longPath(), otherSelected = prepareLocalIpcPath(other, true), target = join(temporary(), 'target');
    writeFileSync(target, 'kept'); symlinkSync(target, `${otherSelected}.bind.lock`);
    await expect(claimLocalIpcBinding(other)).rejects.toThrow('Cannot open');
    expect(readFileSync(target, 'utf8')).toBe('kept');
  });

  test('missing native assets refuse binding before any socket can be published', async () => {
    const root = temporary(), context = join(root, 'src/core/context'), persistence = join(root, 'src/core/persistence');
    mkdirSync(context, { recursive: true }); mkdirSync(persistence, { recursive: true });
    cpSync(resolve(import.meta.dir, '../src/core/context/ipc-path.ts'), join(context, 'ipc-path.ts'));
    cpSync(resolve(import.meta.dir, '../src/core/context/windows-ipc.ts'), join(context, 'windows-ipc.ts'));
    cpSync(resolve(import.meta.dir, '../src/core/persistence/native-lock.ts'), join(persistence, 'native-lock.ts'));
    cpSync(dirname(require.resolve('detect-libc/package.json')), join(root, 'node_modules/detect-libc'), { recursive: true });
    const socket = join(root, 'socket'), selected = localIpcSocketPath(socket);
    if (selected !== socket) dirs.add(dirname(selected));
    const code = `const {claimLocalIpcBinding}=await import(process.argv[1]); try { await claimLocalIpcBinding(process.argv[2]); process.exit(9); } catch (error) { if(error.code!=='writer_lock_unavailable') throw error; }`;
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', code, join(context, 'ipc-path.ts'), socket], { stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
    expect(existsSync(selected)).toBe(false);
    expect(existsSync(`${selected}.bind.lock`)).toBe(false);
  });
});

test('Windows pipe prefix normalization is pure and preserves the complete Unicode name', () => {
  const name = `example-${'界'.repeat(120)}-Σ`;
  const canonical = `\\\\.\\pipe\\${name}`;
  for (const prefix of ['\\\\.\\pipe\\', '\\\\?\\PIPE\\', '//./pipe/', '//?/PiPe/']) expect(windowsPipeName(prefix + name)).toBe(canonical);
  for (const invalid of ['relative', '\\\\server\\pipe\\name', '\\\\.\\pipe\\', '\\\\.\\pipe\\bad\0name']) expect(() => windowsPipeName(invalid)).toThrow();
});


test('plain local paths elect one listener and retain native exclusion through active-connection shutdown on every OS', async () => {
  const path = join(temporary(true), 'plain.sock');
  const pair = await Promise.all([0, 1].map(() => startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) })));
  expect(pair.filter(Boolean)).toHaveLength(1);
  const first = pair.find(Boolean)!; const server = track(first.server);
  const accepted = once(server, 'connection');
  const socket = await connect(path); const [peer] = await accepted; sockets.add(peer);
  const closed = new Promise<void>(done => server.once('close', done));
  server.close();
  expect(await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) })).toBeNull();
  socket.destroy(); peer.destroy(); await closed;
  track((await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) }))?.server ?? null);
  expect((await requestPersistenceCapabilities(path)).brain_id).toBe(BRAIN);
});


test.skipIf(process.platform !== 'win32')('Windows named pipes elect one actual provider and allow a successor after close', async () => {
  const path = String.raw`\\.\pipe\gbrain-ipc-${randomUUID()}`;
  const pair = await Promise.all([0, 1].map(() => startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) })));
  expect(pair.filter(Boolean)).toHaveLength(1);
  const first = pair.find(Boolean)!; track(first.server);
  expect(first.socketPath).toBe(path);
  expect((await requestPersistenceCapabilities(path)).brain_id).toBe(BRAIN);
  expect(await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) })).toBeNull();
  const closed = once(first.server, 'close'); first.close(); await closed;
  track((await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) }))?.server ?? null);
  expect((await requestPersistenceCapabilities(path)).brain_id).toBe(BRAIN);
});

describe.skipIf(process.platform !== 'win32')('Windows native IPC ownership', () => {
  function child(mode: string, path: string, output: string, barrier: string, env = {}) {
    const process = Bun.spawn([globalThis.process.execPath, '--no-env-file', resolve(import.meta.dir, 'fixtures/windows-ipc-mutex.ts'), mode, path, output, barrier], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...globalThis.process.env, ...env },
    }); children.push(process); return process;
  }
  async function ready(process: ReturnType<typeof child>, output: string) {
    await waitFor(() => existsSync(output) || process.exitCode !== null, { timeoutMs: 15000 });
    if (!existsSync(output)) throw new Error(await new Response(process.stderr).text());
    expect(readFileSync(output, 'utf8')).toBe('acquired');
  }
  async function caseProbe(first: string, second: string) {
    const probe = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(import.meta.dir, 'fixtures/windows-ipc-case-probe.ps1'), first, second], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    children.push(probe); probe.stdin.end();
    const [probeExit, probeOutput, probeError] = await Promise.all([probe.exited, new Response(probe.stdout).text(), new Response(probe.stderr).text()]);
    if (probeExit !== 0) throw new Error(probeError);
    return JSON.parse(probeOutput);
  }
  test('case, prefix and Unicode aliases reach one actual listener and share its claim', async () => {
    const name = `gbrain-${randomUUID()}-σé`, path = `\\\\.\\pipe\\${name}`;
    const listener = await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) });
    expect(listener).not.toBeNull(); track(listener!.server);
    // Prove the kernel-facing pipe alias before testing our hashed claim;
    // JavaScript casing alone cannot establish Windows namespace identity.
    const upperPath = `\\\\.\\pipe\\${name.toUpperCase()}`;
    const casing = await caseProbe('σé', 'ΣÉ');
    let capability: Awaited<ReturnType<typeof requestPersistenceCapabilities>> | undefined;
    try { capability = await requestPersistenceCapabilities(upperPath); }
    finally { console.info('WINDOWS_IPC_CASE_PROBE', JSON.stringify({ ...casing, kernel_alias: capability?.brain_id === BRAIN })); }
    expect(capability?.brain_id).toBe(BRAIN);
    expect(casing.ordinal_result).toBe(2);
    expect(casing.first_nt_upper).toBe(casing.second_nt_upper);
    expect(casing.first_locale_upper).toBe(casing.second_locale_upper);
    for (const alias of [`\\\\?\\PIPE\\${name.toUpperCase()}`, `//./pipe/${name.toUpperCase()}`, path]) {
      const contender = await claimLocalIpcBinding(alias);
      try { expect(contender).toBeNull(); } finally { await contender?.release(); }
    }
    const closed = once(listener!.server, 'close'); listener!.close(); await closed;
    const next = await claimLocalIpcBinding(upperPath); expect(next).not.toBeNull();
    await next!.release(); await next!.release();
  });
  test('Windows-distinct dotless names retain separate actual providers and claims', async () => {
    const name = `gbrain-${randomUUID()}-σıé`, firstPath = `\\\\.\\pipe\\${name}`, secondPath = `\\\\.\\pipe\\${name.toUpperCase()}`;
    const secondBrain = '20000000-0000-4000-8000-000000000002';
    const first = await startPersistenceIpcServer(firstPath, { brainId: BRAIN, dispatch: async () => ({}) });
    expect(first).not.toBeNull(); track(first!.server);
    const casing = await caseProbe('σıé', 'ΣIÉ');
    await expect(requestPersistenceCapabilities(secondPath)).rejects.toMatchObject({ sent: false });
    console.info('WINDOWS_IPC_CASE_PROBE', JSON.stringify({ ...casing, kernel_alias: false }));
    expect(casing.ordinal_result).not.toBe(0);
    expect(casing.ordinal_result).not.toBe(2);
    expect(casing.first_nt_upper).not.toBe(casing.second_nt_upper);
    expect(casing.first_locale_upper).not.toBe(casing.second_locale_upper);
    const second = await startPersistenceIpcServer(secondPath, { brainId: secondBrain, dispatch: async () => ({}) });
    expect(second).not.toBeNull(); track(second!.server);
    expect((await requestPersistenceCapabilities(firstPath)).brain_id).toBe(BRAIN);
    expect((await requestPersistenceCapabilities(secondPath)).brain_id).toBe(secondBrain);
    for (const path of [firstPath, secondPath]) {
      const contender = await claimLocalIpcBinding(path);
      try { expect(contender).toBeNull(); } finally { await contender?.release(); }
    }
  });
  test('two processes with distinct homes elect one actual pipe provider and survive owner death', async () => {
    const path = `\\\\.\\pipe\\gbrain-${randomUUID()}`, root = temporary(), barrier = join(root, 'start');
    const outputs = [join(root, 'a'), join(root, 'b')];
    const pair = outputs.map((output, index) => child('server', path, output, barrier,
      { HOME: join(root, `home-${index}`), GBRAIN_HOME: join(root, `brain-${index}`), TMPDIR: join(root, `tmp-${index}`) }));
    await waitFor(() => outputs.every(output => existsSync(`${output}.ready`)), { timeoutMs: 15000 });
    writeFileSync(barrier, 'go');
    await waitFor(() => outputs.every(existsSync), { timeoutMs: 15000 });
    const outcomes = outputs.map(output => readFileSync(output, 'utf8'));
    expect([...outcomes].sort()).toEqual(['acquired', 'busy']);
    expect((await requestPersistenceCapabilities(path)).brain_id).toBe(BRAIN);
    const owner = pair[outcomes.indexOf('acquired')]; owner.kill(9); await owner.exited;
    track((await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) }))?.server ?? null);
    expect((await requestPersistenceCapabilities(path)).brain_id).toBe(BRAIN);
  });
  test('an already-open contender acquires an abandoned kernel mutex after actual process death', async () => {
    const root = temporary(), path = `\\\\.\\pipe\\gbrain-${randomUUID()}`, barrier = join(root, 'start');
    writeFileSync(barrier, 'go');
    const owner = child('mutex', path, join(root, 'owner'), barrier); await ready(owner, join(root, 'owner'));
    const release = join(root, 'release'), output = join(root, 'next');
    const waiter = child('abandoned', path, output, release);
    await waitFor(() => existsSync(`${output}.ready`), { timeoutMs: 15000 });
    expect(await tryAcquireNativeIpcMutex(path)).toBeNull();
    owner.kill(9); await owner.exited; writeFileSync(release, 'go'); await ready(waiter, output);
    expect(await tryAcquireNativeIpcMutex(path)).toBeNull();
    waiter.stdin.write('close'); waiter.stdin.end(); expect(await waiter.exited).toBe(0);
    const next = await tryAcquireNativeIpcMutex(path); expect(next).not.toBeNull(); await next!.release();
  });
  test('opaque finalizers and worker-environment cleanup relinquish claims without exiting the process', async () => {
    for (const mode of ['finalize', 'worker', 'copied-addon']) {
      const root = temporary(), output = join(root, 'result');
      const process = child(mode, `\\\\.\\pipe\\gbrain-${randomUUID()}`, output, '-');
      expect(await process.exited).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('released');
    }
  });
  test('a denied Global mutex fails closed and closes after its owner exits', async () => {
    const root = temporary(), name = `gbrain-${randomUUID()}`, path = `\\\\.\\pipe\\${name}`, output = join(root, 'ready');
    const identity = createHash('sha256').update(name.toUpperCase(), 'utf16le').digest('hex');
    const process = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(import.meta.dir, 'fixtures/windows-ipc-denied.ps1'), `Global\\gbrain-ipc-${identity}`, output], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    children.push(process);
    await waitFor(() => existsSync(output) || process.exitCode !== null, { timeoutMs: 15000 });
    if (!existsSync(output)) throw new Error(await new Response(process.stderr).text());
    await expect(tryAcquireNativeIpcMutex(path)).rejects.toThrow();
    process.stdin.write('close\n'); process.stdin.end(); expect(await process.exited).toBe(0);
    const next = await tryAcquireNativeIpcMutex(path); expect(next).not.toBeNull(); await next!.release();
  });
  test('native stale cleanup preserves regular files, directories and junction targets', async () => {
    for (const kind of ['file', 'directory', 'junction']) {
      const root = temporary(), path = join(root, 'socket'), target = join(root, 'target');
      if (kind === 'file') writeFileSync(path, 'kept');
      else if (kind === 'directory') mkdirSync(path);
      else { mkdirSync(target); writeFileSync(join(target, 'kept'), 'kept'); symlinkSync(target, path, 'junction'); }
      const claim = await claimLocalIpcBinding(path); expect(claim).not.toBeNull();
      try { expect(() => claim!.removeStaleWindowsSocket!()).toThrow(); }
      finally { await claim!.release(); }
      if (kind === 'file') expect(readFileSync(path, 'utf8')).toBe('kept');
      if (kind === 'directory') expect(lstatSync(path).isDirectory()).toBe(true);
      if (kind === 'junction') { expect(lstatSync(path).isSymbolicLink()).toBe(true); expect(readFileSync(join(target, 'kept'), 'utf8')).toBe('kept'); }
      expect(() => claim!.removeStaleWindowsSocket!()).toThrow();
    }
  });
});
