/** Optional protected local transport; shares the caller's app, OAuth and engine. */
import http, { type RequestListener } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export function assertPrivateSocketParent(filename: string): void {
  if (!filename || !path.isAbsolute(filename) || path.resolve(filename) !== filename || process.getuid === undefined)
    throw new Error('private_http_requires_absolute_unix_path');
  const uid = process.getuid();
  const parents: string[] = [];
  let current = path.parse(filename).root;
  parents.push(current);
  for (const part of path.dirname(filename).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); parents.push(current);
  }
  for (let i = 0; i < parents.length; i++) {
    const st = fs.lstatSync(parents[i]!);
    if (st.isSymbolicLink() || !st.isDirectory() || ![0, uid].includes(st.uid))
      throw new Error('unsafe_private_http_ancestor');
    if (st.mode & 0o022) {
      const next = parents[i + 1] && fs.lstatSync(parents[i + 1]!);
      if (!(st.uid === 0 && (st.mode & 0o1000) && next && next.isDirectory() &&
        !next.isSymbolicLink() && next.uid === uid && !(next.mode & 0o077)))
        throw new Error('unsafe_private_http_ancestor');
    }
  }
  const parent = fs.lstatSync(path.dirname(filename));
  if (parent.uid !== uid || (parent.mode & 0o077)) throw new Error('unsafe_private_http_parent');
}

export async function listenPrivateHttp(handler: RequestListener, filename: string) {
  assertPrivateSocketParent(filename);
  try { fs.lstatSync(filename); throw new Error('private_http_path_exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const sockets = new Set<WeakRef<import('node:net').Socket>>();
  const server = http.createServer((req, res) => {
    // UDS peers have no IP. Use one fixed local bucket rather than disabling
    // IP-based rate limits or trusting forwarded headers on this transport.
    Object.defineProperty(req, 'ip', { value: '127.0.0.1', configurable: true });
    Object.defineProperty(req, 'ips', { value: [], configurable: true });
    handler(req, res);
  });
  server.on('connection', socket => {
    // Bun may release an idle wrapper without emitting close; do not retain it.
    for (const ref of sockets) if (!ref.deref()) sockets.delete(ref);
    const ref = new WeakRef(socket);
    sockets.add(ref); socket.once('close', () => sockets.delete(ref));
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= new Promise((resolve, reject) => {
    for (const ref of sockets) ref.deref()?.destroy();
    server.closeAllConnections?.();
    if (!server.listening) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('private_http_close_timeout')), 2000);
    timer.unref();
    server.close(error => { clearTimeout(timer); error ? reject(error) : resolve(); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(filename, () => { if (server.listening) resolve(); });
    });
    fs.chmodSync(filename, 0o600);
    return { server, close };
  } catch (error) { await close(); throw error; }
}

/** A failed optional listener cleanup must not skip engine/IPC teardown. */
export async function closePrivateHttpSafely(
  listener: { close(): Promise<void> } | null,
  log: (message: string) => void = message => console.error(message),
): Promise<void> {
  try { await listener?.close(); }
  catch { log('GBrain private HTTP listener: close failed; continuing engine cleanup'); }
}
