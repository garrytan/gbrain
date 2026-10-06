/**
 * Starting a real `gbrain serve --http` from a test without a port race.
 *
 * A port picked at random (`43000 + Math.random() * 2000`) sits inside the
 * kernel's ephemeral range (Linux 32768-60999). Any socket on the machine may
 * already hold it: another file's port-0 listener, a live loopback connection,
 * or a client connection closed in the last 60 s (TIME_WAIT). serve then
 * exits with serve_port_in_use, and a harness that discards its output only
 * sees /health fail until its deadline. `freePort()` asks the kernel for a
 * port nothing holds, and `startServeHttp()` keeps serve's output and fails
 * as soon as the child exits.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts');

/** A 127.0.0.1 port the kernel reports free right now: bind port 0, read it, release it. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export interface ServeHttp {
  port: number;
  /** `http://127.0.0.1:<port>` */
  base: string;
  child: ChildProcess;
  /** Everything serve wrote to stdout and stderr so far. */
  output(): string;
  /** SIGTERM, then wait for the exit. */
  stop(): Promise<void>;
}

/**
 * `gbrain serve --http --bind 127.0.0.1 --port <free port> [...args]`, resolved once
 * GET /health answers ok. If serve exits first (a taken port, a held lock, a bad
 * config) this throws at once with serve's output; a deadline failure carries it too.
 */
export async function startServeHttp(opts: { cwd: string; env: Record<string, string>; args?: string[]; timeoutMs?: number }): Promise<ServeHttp> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--no-env-file', CLI, 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), ...(opts.args ?? [])],
    { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr!.on('data', (d: Buffer) => { output += d.toString(); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const drained = new Promise<void>(resolve => child.once('close', () => resolve()));
  const settledOutput = async () => { await Promise.race([drained, Bun.sleep(1000)]); return output.slice(-4000); };
  const running = () => child.exitCode === null && child.signalCode === null;
  const stop = async () => {
    if (running()) child.kill('SIGTERM');
    await exited;
  };
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!running()) {
      throw new Error(`gbrain serve --http on ${base} exited (code ${child.exitCode}, signal ${child.signalCode}) before /health answered ok. Its output:\n${await settledOutput()}`);
    }
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return { port, base, child, output: () => output, stop };
    if (Date.now() >= deadline) {
      child.kill('SIGKILL');
      await exited;
      throw new Error(`gbrain serve --http on ${base} did not answer /health ok within ${timeoutMs}ms. Its output:\n${await settledOutput()}`);
    }
    await Bun.sleep(250);
  }
}
