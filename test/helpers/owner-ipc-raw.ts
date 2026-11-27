/**
 * A raw owner-socket connection for tests: sends frames exactly as given and collects every frame the other side
 * sends, so a test can break the owner protocol on purpose (src/core/rust-engine/owner-ipc/).
 */
import net from 'node:net';

export type Frame = Record<string, unknown>;

/** A raw connection: sends frames as given and collects every frame the other side sends. */
export function rawSession(socketPath: string) {
  const socket = net.connect(socketPath);
  const frames: Frame[] = [];
  const waiters: Array<() => void> = [];
  let buf = '';
  let closed = false;
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) if (line) frames.push(JSON.parse(line) as Frame);
    for (const wake of waiters.splice(0)) wake();
  });
  socket.on('close', () => { closed = true; for (const wake of waiters.splice(0)) wake(); });
  const connected = new Promise<void>(resolve => socket.once('connect', () => resolve()));
  return {
    frames,
    get closed() { return closed; },
    send: async (frame: Frame) => { await connected; socket.write(JSON.stringify(frame) + '\n'); },
    /** The first frame that matches, or null when the socket closes or 2 s pass first. */
    next: async (match: (frame: Frame) => boolean): Promise<Frame | null> => {
      const deadline = Date.now() + 2_000;
      for (;;) {
        const found = frames.find(match);
        if (found) return found;
        if (closed || Date.now() >= deadline) return null;
        await Promise.race([new Promise<void>(resolve => waiters.push(resolve)), Bun.sleep(50)]);
      }
    },
    /** True when the other side closed the socket within 2 s. */
    closes: async () => { for (let i = 0; i < 40 && !closed; i++) await Bun.sleep(50); return closed; },
    destroy: () => socket.destroy(),
  };
}

