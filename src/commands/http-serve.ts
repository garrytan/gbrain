import type { BrainEngine } from '../core/engine.ts';
import { startHttpServer } from '../http/server.ts';

export async function runHttpServe(engine: BrainEngine, args: string[]): Promise<void> {
  const port = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1] ?? '4242', 10);
  const host = args.find(a => a.startsWith('--host='))?.split('=')[1] ?? '0.0.0.0';
  startHttpServer(engine, { port, host });
  // keep the process alive — Bun.serve() is non-blocking
  await new Promise(() => {});
}
