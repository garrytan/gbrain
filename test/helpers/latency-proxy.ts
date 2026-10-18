/**
 * A TCP proxy that adds a fixed round-trip latency to a Postgres (or PgBouncer)
 * endpoint, for convergence and timing tests: every chunk is delayed by half
 * the round trip in each direction, preserving order. `drop()` destroys every
 * live connection at once, as a pooler restart looks to its clients.
 */
import { createConnection, createServer, type Server, type Socket } from 'node:net';

/** A TCP proxy that delays every chunk by half the configured round trip in each direction, preserving order. */
export class LatencyProxy {
  private server: Server;
  private sockets = new Set<Socket>();
  port = 0;
  constructor(private target: { host: string; port: number }, private oneWayMs: number) {
    this.server = createServer(client => this.accept(client));
  }
  async listen(): Promise<void> {
    await new Promise<void>(done => this.server.listen(0, '127.0.0.1', done));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('latency proxy has no port');
    this.port = address.port;
  }
  private delayed(from: Socket, to: Socket): void {
    const queue: { at: number; chunk: Buffer }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = () => {
      timer = undefined;
      const now = performance.now();
      while (queue.length && queue[0].at <= now) { const { chunk } = queue.shift()!; if (!to.destroyed) to.write(chunk); }
      if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].at - performance.now()));
    };
    from.on('data', (chunk: Buffer) => {
      queue.push({ at: performance.now() + this.oneWayMs, chunk });
      if (!timer) timer = setTimeout(drain, this.oneWayMs);
    });
    from.on('end', () => { const close = () => (queue.length ? setTimeout(close, this.oneWayMs) : to.end()); close(); });
  }
  private accept(client: Socket): void {
    const upstream = createConnection(this.target);
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
    }
    this.delayed(client, upstream);
    this.delayed(upstream, client);
  }
  /** Mode (f): every live connection through the pooler drops at once, as a pooler restart looks to its clients. */
  drop(): number { const n = this.sockets.size; for (const socket of this.sockets) socket.destroy(); return n; }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(done => this.server.close(() => done()));
  }
}
