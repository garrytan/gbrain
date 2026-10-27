import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { childGlobalFlags, DEFAULT_CLI_OPTIONS, parseGlobalFlags, setCliOptions, _resetCliOptionsForTest } from '../src/core/cli-options.ts';
import { connectThroughProxy, openDbSocket } from '../src/core/db-proxy.ts';
import { traceSqlOptions } from '../src/core/sql-trace.ts';
import { withEnv } from './helpers/with-env.ts';

interface FakeProxy { url: URL; requests: string[]; close(): Promise<void> }

/** A CONNECT proxy on 127.0.0.1 that answers `status` and, on 200, splices the client to `target`. */
async function fakeProxy(status: string, target?: net.AddressInfo): Promise<FakeProxy> {
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(client => {
    sockets.add(client);
    let head = '';
    client.on('data', function onData(chunk) {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      client.off('data', onData);
      requests.push(head);
      client.write(`HTTP/1.1 ${status}\r\n\r\n`);
      if (!status.startsWith('200') || !target) { client.end(); return; }
      const upstream = net.connect(target.port, '127.0.0.1');
      sockets.add(upstream);
      client.pipe(upstream).pipe(client);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    requests,
    close: () => new Promise(resolve => { sockets.forEach(s => s.destroy()); server.close(() => resolve()); }),
  };
}

async function echoServer(): Promise<{ address: net.AddressInfo; close(): Promise<void> }> {
  const server = net.createServer(socket => socket.pipe(socket));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { address: server.address() as net.AddressInfo, close: () => new Promise(resolve => server.close(() => resolve())) };
}

function roundTrip(socket: net.Socket, payload: string): Promise<string> {
  return new Promise(resolve => {
    socket.once('data', chunk => resolve(chunk.toString()));
    socket.write(payload);
  });
}

afterEach(() => _resetCliOptionsForTest());

describe('connectThroughProxy', () => {
  test('tunnels to the target named in CONNECT and tags the socket for TLS SNI', async () => {
    const echo = await echoServer();
    const proxy = await fakeProxy('200 Connection established', echo.address);
    try {
      const socket = await connectThroughProxy(proxy.url, 'db.example.internal', 5432);
      expect(proxy.requests[0]).toStartWith('CONNECT db.example.internal:5432 HTTP/1.1\r\nHost: db.example.internal:5432\r\n');
      expect((socket as unknown as { host: string }).host).toBe('db.example.internal');
      expect(await roundTrip(socket, 'ping')).toBe('ping');
      socket.destroy();
    } finally {
      await proxy.close();
      await echo.close();
    }
  });

  test('sends decoded basic credentials from the proxy URL', async () => {
    const echo = await echoServer();
    const proxy = await fakeProxy('200 OK', echo.address);
    try {
      const url = new URL(proxy.url);
      url.username = 'svc';
      url.password = 'p%40ss';
      (await connectThroughProxy(url, 'db.example.internal', 5432)).destroy();
      expect(proxy.requests[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from('svc:p@ss').toString('base64')}\r\n`);
    } finally {
      await proxy.close();
      await echo.close();
    }
  });

  test('rejects with the proxy status line when CONNECT is refused', async () => {
    const proxy = await fakeProxy('403 Forbidden');
    try {
      await expect(connectThroughProxy(proxy.url, 'db.example.internal', 5432))
        .rejects.toThrow('refused CONNECT to db.example.internal:5432 (HTTP/1.1 403 Forbidden)');
    } finally {
      await proxy.close();
    }
  });
});

describe('openDbSocket', () => {
  test('goes through the proxy only when --db-proxy is set', async () => {
    const echo = await echoServer();
    const proxy = await fakeProxy('200 OK', echo.address);
    try {
      const direct = await openDbSocket({ host: ['127.0.0.1'], port: [echo.address.port] });
      direct.destroy();
      expect(proxy.requests).toHaveLength(0);

      setCliOptions({ ...DEFAULT_CLI_OPTIONS, dbProxy: proxy.url });
      const tunnelled = await openDbSocket({ host: ['db.example.internal'], port: [5432] });
      expect(await roundTrip(tunnelled, 'via proxy')).toBe('via proxy');
      tunnelled.destroy();
      expect(proxy.requests).toHaveLength(1);
    } finally {
      await proxy.close();
      await echo.close();
    }
  });
});

describe('traceSqlOptions with --db-proxy', () => {
  test('adds the tunnelled socket when tracing is off', () => withEnv({ GBRAIN_SQL_TRACE: undefined }, () => {
    const options = { max: 1 };
    expect(traceSqlOptions(options, 'module')).toBe(options);
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, dbProxy: new URL('http://127.0.0.1:8080') });
    expect(traceSqlOptions(options, 'module') as Record<string, unknown>).toEqual({ max: 1, socket: openDbSocket });
  }));
});

describe('--db-proxy global flag', () => {
  test('both spellings are parsed and stripped before the command', () => {
    for (const argv of [['--db-proxy', 'http://proxy.example:8080', 'serve'], ['serve', '--db-proxy=http://proxy.example:8080']]) {
      const { cliOpts, rest } = parseGlobalFlags(argv);
      expect(cliOpts.dbProxy?.href).toBe('http://proxy.example:8080/');
      expect(rest).toEqual(['serve']);
    }
  });

  test('rejects anything but an http://host:port URL', () => {
    for (const value of [
      [],
      ['--json'],
      ['https://proxy.example:8443'],
      ['socks5://proxy.example:1080'],
      ['http://proxy.example'],
      ['http://proxy.example:8080/tunnel'],
      ['http://user:pa$s@proxy.example:8080'],
    ]) {
      expect(() => parseGlobalFlags(['--db-proxy', ...value, 'serve'])).toThrow('--db-proxy');
    }
  });

  test('children inherit the proxy', () => {
    const { cliOpts } = parseGlobalFlags(['--db-proxy', 'http://svc:p%24ss@proxy.example:8080', 'sync']);
    expect(childGlobalFlags(cliOpts)).toBe(' --db-proxy=http://svc:p%24ss@proxy.example:8080/');
    expect(childGlobalFlags({ ...DEFAULT_CLI_OPTIONS })).not.toContain('--db-proxy');
  });
});
