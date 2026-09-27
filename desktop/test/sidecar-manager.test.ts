import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { SidecarManager, classifySidecarStartupError } from '../src/main/sidecar-manager.js';

const logger = { write() {}, close() {}, directory: '', filePath: '' } as any;

describe('desktop sidecar manager', () => {
  test('PGLite 数据库打开失败时立即停止，不连续重启多个 sidecar', async () => {
    const states: any[] = [];
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.92',
      logger,
      onState: state => states.push(state),
    });
    let recoveryAttempts = 0;
    (manager as any).recoverAfterCrash = async () => { recoveryAttempts += 1; };

    (manager as any).handleCrash(
      'PGLite failed to initialize its WASM runtime. Original error: Aborted().',
    );
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(recoveryAttempts).toBe(0);
    expect(states.at(-1)).toMatchObject({
      phase: 'failed',
      message: expect.stringContaining('Aborted()'),
    });
  });

  test('退出或安装更新时等待 sidecar 子进程树真正结束后才继续', async () => {
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.92',
      logger,
    });
    const child = new EventEmitter() as any;
    child.pid = 12345;
    child.exitCode = null;
    (manager as any).child = child;
    const requested: boolean[] = [];
    (manager as any).requestProcessTreeStop = (_child: unknown, force: boolean) => {
      requested.push(force);
      setTimeout(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      }, 10);
    };

    await (manager as any).terminateChild();

    expect(requested).toEqual([false]);
    expect(child.exitCode).toBe(0);
  });

  test('health timeout writes pid, exit code and complete stderr into desktop logs', async () => {
    const lines: Array<{ source: string; text: string }> = [];
    const capturingLogger = {
      write(source: string, value: string | Buffer) {
        lines.push({ source, text: String(value) });
      },
      close() {},
      directory: '',
      filePath: '',
    } as any;
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.1.48',
      healthTimeoutMs: 80,
      logger: capturingLogger,
    });
    (manager as any).spawnProcess = () => {
      (manager as any).child = { pid: 4242, exitCode: null };
      (manager as any).recentStderr = '  [119] pglite_cjk_trigram_candidate_indexes...\n';
    };
    (manager as any).terminateChild = async () => {
      (manager as any).lastExitCode = 1;
      (manager as any).lastExitSignal = null;
      (manager as any).child = null;
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('fetch failed'))) as typeof fetch;
    try {
      await expect(manager.start()).rejects.toThrow(/健康检查超时|fetch failed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const joined = lines.map((line) => `[${line.source}] ${line.text}`).join('\n');
    expect(joined).toContain('exitCode=1');
    expect(joined).toContain('pid=4242');
    expect(joined).toContain('pglite_cjk_trigram_candidate_indexes');
    expect(joined).toMatch(/sidecar:stderr/);
  });

  test('health timeout with silent sidecar still records empty stderr and missing exit code', async () => {
    const lines: Array<{ source: string; text: string }> = [];
    const capturingLogger = {
      write(source: string, value: string | Buffer) {
        lines.push({ source, text: String(value) });
      },
      close() {},
      directory: '',
      filePath: '',
    } as any;
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.1.48',
      healthTimeoutMs: 80,
      logger: capturingLogger,
    });
    (manager as any).spawnProcess = () => {
      (manager as any).child = { pid: 5252, exitCode: null };
      (manager as any).recentStderr = '';
    };
    (manager as any).terminateChild = async () => {
      (manager as any).lastExitCode = 1;
      (manager as any).child = null;
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('fetch failed'))) as typeof fetch;
    try {
      await expect(manager.start()).rejects.toThrow(/健康检查超时|fetch failed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const joined = lines.map((line) => `[${line.source}] ${line.text}`).join('\n');
    expect(joined).toContain('exitCode=1');
    expect(joined).toContain('(empty)');
  });

  test('reports the last sidecar stderr instead of a generic health-check failure', async () => {
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.91',
      logger,
    });
    (manager as any).lastExitMessage =
      'Sidecar exited (code 1). PGLite failed to initialize its WASM runtime. Original error: Aborted().';
    (manager as any).child = null;

    await expect((manager as any).waitUntilHealthy()).rejects.toThrow(
      /PGLite failed to initialize its WASM runtime|exited before it became healthy/,
    );
  });

  test('16. DatabaseAlreadyOwnedError does not trigger auto restart loop', async () => {
    const states: Array<{ phase: string }> = [];
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.93',
      logger,
      onState: (state) => states.push(state),
    });
    let spawnCount = 0;
    (manager as any).spawnProcess = () => {
      spawnCount += 1;
      (manager as any).child = { exitCode: null, pid: 1 };
    };
    (manager as any).waitUntilHealthy = async () => {
      throw new Error('DatabaseAlreadyOwnedError: already owned by pid 99');
    };
    (manager as any).terminateChild = async () => {
      (manager as any).child = null;
    };

    await expect(manager.start()).rejects.toThrow(/already owned|DatabaseAlreadyOwned/);
    expect(spawnCount).toBe(1);
    expect(states.some((s) => s.phase === 'failed')).toBe(true);
    const classified = classifySidecarStartupError(new Error('DatabaseAlreadyOwnedError'));
    expect(classified.retryable).toBe(false);
  });

  test('18. health check fails immediately when sidecar already exited', async () => {
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.93',
      logger,
    });
    (manager as any).child = null;
    (manager as any).lastExitMessage = 'Sidecar exited (code 1). Aborted()';
    const t0 = Date.now();
    await expect((manager as any).waitUntilHealthy()).rejects.toThrow(/exited before it became healthy|Aborted/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test('recoverAfterCrash skips retry for non-retryable database errors', async () => {
    const states: Array<{ phase: string; message?: string }> = [];
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.93',
      logger,
      onState: (state) => states.push(state),
    });
    let spawnCount = 0;
    (manager as any).spawnProcess = () => { spawnCount += 1; };
    await (manager as any).recoverAfterCrash('PGlite.create failed: Aborted()');
    expect(spawnCount).toBe(0);
    expect(states.at(-1)?.phase).toBe('failed');
  });

  test('times out administrator-session creation instead of leaving startup waiting forever', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    })) as typeof fetch;
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.91',
      adminRequestTimeoutMs: 25,
      logger,
    });

    try {
      const outcome = await Promise.race([
        (manager as any).issueMagicLink().then(
          () => 'resolved',
          (error: unknown) => error instanceof Error ? error.message : String(error),
        ),
        new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 200)),
      ]);
      expect(outcome).not.toBe('still waiting');
      expect(outcome).toContain('administrator session');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('terminates the child when startup health checks fail', async () => {
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.24',
      logger,
    });
    let terminated = false;
    (manager as any).spawnProcess = () => undefined;
    (manager as any).waitUntilHealthy = async () => { throw new Error('health failed'); };
    (manager as any).terminateChild = async () => { terminated = true; };

    await expect(manager.start()).rejects.toThrow('health failed');
    expect(terminated).toBe(true);
  });

  test('serializes concurrent starts without spawning a second child', async () => {
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.57',
      logger,
    });
    let spawnCount = 0;
    (manager as any).spawnProcess = () => {
      spawnCount += 1;
      (manager as any).child = { exitCode: null };
    };
    (manager as any).waitUntilHealthy = async () => undefined;
    (manager as any).issueMagicLink = async () => 'http://127.0.0.1:3131/admin';

    const results = await Promise.all([manager.start(), manager.start()]);
    expect(results).toEqual(['http://127.0.0.1:3131/admin', 'http://127.0.0.1:3131/admin']);
    expect(spawnCount).toBe(1);
  });

  test('preflights LAN Bearer credentials with a fixed loopback MCP request', async () => {
    const seenBodies: Array<Record<string, any>> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        seenBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const authorization = String(req.headers.authorization ?? '');
        const status = authorization === 'Bearer valid'
          ? 200
          : authorization === 'Bearer revoked' ? 401 : 503;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port.');
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: address.port,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.57',
      logger,
    });

    try {
      expect(await manager.verifyMcpBearer('Bearer valid')).toBe(true);
      expect(await manager.verifyMcpBearer('Bearer revoked')).toBe(false);
      await expect(manager.verifyMcpBearer('Bearer unavailable')).rejects.toThrow('HTTP 503');
      expect(seenBodies).toHaveLength(3);
      expect(seenBodies.every(body => body.method === 'initialize')).toBe(true);
      expect(seenBodies.every(body => body.id === 'pmbrain-lan-auth-check')).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('reuses the Admin cookie and renews it once after a 401', async () => {
    let issuedLinks = 0;
    let activeSession = 'session-1';
    let rejectCurrentSession = false;
    const server = createServer((req, res) => {
      if (req.url === '/admin/api/issue-magic-link') {
        issuedLinks += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: `http://127.0.0.1:${(server.address() as any).port}/admin/auth/${issuedLinks}` }));
        return;
      }
      if (req.url?.startsWith('/admin/auth/')) {
        activeSession = `session-${req.url.split('/').at(-1)}`;
        res.writeHead(302, {
          location: '/admin/',
          'set-cookie': `pmbrain_admin=${activeSession}; HttpOnly; Path=/admin`,
        });
        res.end();
        return;
      }
      if (req.url === '/admin/api/value') {
        const cookie = String(req.headers.cookie ?? '');
        if (!cookie.includes(activeSession) || rejectCurrentSession) {
          rejectCurrentSession = false;
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'expired' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port.');
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: address.port,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.78',
      logger,
    });

    try {
      expect(await manager.adminRequest('/admin/api/value')).toEqual({ ok: true });
      expect(await manager.adminRequest('/admin/api/value')).toEqual({ ok: true });
      expect(issuedLinks).toBe(1);

      rejectCurrentSession = true;
      expect(await manager.adminRequest('/admin/api/value')).toEqual({ ok: true });
      expect(issuedLinks).toBe(2);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  test('preserves upload bytes, text responses and HTTP failures', async () => {
    const bytes: number[] = [];
    const server = createServer((req, res) => {
      if (req.url === '/admin/api/issue-magic-link') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: `http://127.0.0.1:${(server.address() as any).port}/admin/auth/test` }));
      } else if (req.url === '/admin/auth/test') {
        res.writeHead(302, { 'set-cookie': 'pmbrain_admin=test; HttpOnly', location: '/admin/' }).end();
      } else {
        req.on('data', chunk => bytes.push(...chunk));
        req.on('end', () => {
          res.writeHead(422, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('原始错误');
        });
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const manager = new SidecarManager({ packaged: false, appPath: '', resourcesPath: '', port: (server.address() as any).port, bootstrapToken: 'test-only', clientVersion: 'test', logger });
    try {
      const response = await manager.adminResponse('/admin/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([0, 128, 255]) });
      expect(response.status).toBe(422);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toBe('原始错误');
      expect(bytes).toEqual([0, 128, 255]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

});
