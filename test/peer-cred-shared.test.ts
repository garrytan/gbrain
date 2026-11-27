/**
 * src/core/peer-cred.ts, the peer-credential reader the warm CLI socket and the Rust engine's owner socket share:
 * on a real Unix socket pair it reads this process's own uid from the kernel, and it rejects a socket with no fd.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { peerCredSupport, peerUid, socketFd } from '../src/core/peer-cred.ts';

const posix = process.platform === 'linux' || process.platform === 'darwin';

describe('shared peer-credential reader (src/core/peer-cred.ts)', () => {
  let dir: string; let server: Server; let accepted: Promise<Socket>; let client: Socket;

  beforeAll(async () => {
    if (!posix) return;
    dir = mkdtempSync(join(tmpdir(), 'gbrain-peer-cred-'));
    const path = join(dir, 's.sock');
    accepted = new Promise(resolve => { server = createServer(socket => resolve(socket)); });
    await new Promise<void>(resolve => server.listen(path, resolve));
    client = connect(path);
    await new Promise<void>(resolve => client.once('connect', () => resolve()));
  });

  afterAll(() => {
    if (!posix) return;
    client?.destroy(); server?.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('resolves once per process and is supported on Linux and macOS', () => {
    const first = peerCredSupport();
    expect(peerCredSupport()).toBe(first);
    if (posix && (process.platform === 'darwin' || process.arch === 'x64' || process.arch === 'arm64')) expect(first.ok).toBe(true);
    if (!first.ok) expect(first.reason.length).toBeGreaterThan(0);
  });

  test('the accepted end of a local socket reads this process uid', async () => {
    const support = peerCredSupport();
    if (!posix || !support.ok) return;
    const socket = await accepted;
    expect(socketFd(socket)).toEqual(expect.any(Number));
    expect(peerUid(socket, support.read)).toBe(process.getuid!());
  });

  test('a socket without a file descriptor, or a reader that throws, reads as no uid', () => {
    const fake = {} as Socket;
    expect(socketFd(fake)).toBeNull();
    expect(peerUid(fake, () => 0)).toBeNull();
    const withFd = { _handle: { fd: 3 } } as unknown as Socket;
    expect(socketFd(withFd)).toBe(3);
    expect(peerUid(withFd, () => { throw new Error('boom'); })).toBeNull();
    expect(peerUid(withFd, () => 501)).toBe(501);
  });
});
