import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { SidecarManager } from '../src/main/sidecar-manager.js';

const logger = { write() {}, close() {}, directory: '', filePath: '' } as any;

describe('desktop sidecar manager', () => {
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
});
