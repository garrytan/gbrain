/**
 * The shared peer-credential reader (src/core/peer-cred.ts): the kernel's answer to "which user is on the other end of
 * this Unix socket", used by the owner socket's uid check, which refuses a peer whose uid cannot be read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { peerCredSupport, peerUid, socketFd } from '../src/core/peer-cred.ts';

const posix = process.platform !== 'win32' && process.getuid !== undefined;
const fake = (fd: unknown): Socket => ({ _handle: { fd } }) as unknown as Socket;

describe('socketFd', () => {
  // Value: protects=a socket the runtime gives no usable descriptor is never read as fd 0 or a wrong fd;
  // fails_when=a negative, fractional, string or missing descriptor is returned instead of null; why_new=the module is new;
  // seam=a plain object stands in for the socket handle; no_claim=the descriptor belongs to a live connection
  test('answers a whole, non-negative descriptor and null for anything else', () => {
    expect(socketFd(fake(7))).toBe(7);
    expect(socketFd(fake(0))).toBe(0);
    for (const bad of [-1, 1.5, Number.NaN, '7', null, undefined]) expect(socketFd(fake(bad))).toBeNull();
    expect(socketFd({} as unknown as Socket)).toBeNull();
    expect(socketFd({ _handle: null } as unknown as Socket)).toBeNull();
  });
});

describe('peerUid', () => {
  // Value: protects=a peer whose uid cannot be read is a rejection (null), never a match; fails_when=a missing descriptor
  // or a throwing reader is answered with a number; why_new=the module is new; seam=a reader function stands in for the
  // kernel call; no_claim=the real kernel answer (the live-socket test below)
  test('passes the descriptor to the reader, and answers null when there is no descriptor or the reader fails', () => {
    const seen: number[] = [];
    expect(peerUid(fake(9), (fd) => { seen.push(fd); return 1234; })).toBe(1234);
    expect(seen).toEqual([9]);
    expect(peerUid(fake(9), () => null)).toBeNull();
    expect(peerUid(fake(9), () => { throw new Error('ffi failed'); })).toBeNull();
    let called = false;
    expect(peerUid(fake(undefined), () => { called = true; return 1; })).toBeNull();
    expect(called).toBe(false);
  });
});

describe('peerCredSupport', () => {
  // Value: protects=the answer is stable for the process and says why a platform is unsupported; fails_when=a second call
  // resolves again, or an unsupported answer carries no reason; why_new=the module is new; seam=none (reads this platform);
  // no_claim=other platforms than the one running
  test('resolves once, and is either a reader or a stated reason', () => {
    const support = peerCredSupport();
    expect(peerCredSupport()).toBe(support);
    if (support.ok) expect(typeof support.read).toBe('function');
    else expect(support.reason.length).toBeGreaterThan(0);
    if (process.platform === 'linux' || process.platform === 'darwin') expect(support.ok).toBe(true);
  });
});

describe('the platform reader on a live Unix socket', () => {
  let dir: string | undefined;
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // Value: protects=the owner socket reads the connecting process's real uid; fails_when=the reader answers another uid,
  // null for a connected socket, or a uid for a descriptor that is not a socket; why_new=the module is new; seam=none
  // (a real server and client in this process, so the peer is this user); no_claim=a peer of another OS user
  test.skipIf(!posix || !peerCredSupport().ok)('reads this process\'s uid from the server side of a connection, and null for a bad descriptor', async () => {
    const support = peerCredSupport();
    if (!support.ok) throw new Error('unreachable: skipped without a reader');
    dir = mkdtempSync(join(tmpdir(), 'peer-cred-'));
    const path = join(dir, 's.sock');
    const answer = new Promise<number | null>((resolve) => {
      server = createServer((socket) => { resolve(peerUid(socket, support.read)); socket.end(); });
    });
    await new Promise<void>((resolve) => server!.listen(path, resolve));
    const client = createConnection(path);
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    expect(await answer).toBe(process.getuid!());
    client.destroy();
    expect(support.read(-1)).toBeNull();
  });
});
