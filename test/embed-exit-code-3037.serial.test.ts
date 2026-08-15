/**
 * #3037 — `gbrain embed` must exit non-zero when chunks failed to embed.
 *
 * Pre-fix, src/cli.ts discarded runEmbed's result entirely, so a run where
 * EVERY chunk failed to embed still exited 0 — cron, CI and health gates read
 * total failure as success. The fix mirrors the `import` case's
 * `errors > 0 → setCliExitVerdict(1)` guard.
 *
 * Real spawned CLI against a tmpdir PGLite brain, with the embedding
 * provider pointed at a local mock llama-server (OpenAI-compatible, no auth)
 * that can be flipped between failing and healthy. Single test, single
 * brain: every spawn pays a cold transpile cost (see
 * apply-migrations-pglite-spawn.serial.test.ts for the rationale).
 *
 * Serial: spawns subprocesses + binds a local port + writes tmpdirs.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIMS = 16;

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

describe('gbrain embed exit code on failures (#3037)', () => {
  test('embed --stale exits non-zero when embedding fails, 0 once it succeeds', async () => {
    // Mock OpenAI-compatible embeddings endpoint, flippable between modes.
    let mode: 'fail' | 'ok' = 'fail';
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/embeddings')) {
          if (mode === 'fail') {
            return new Response(JSON.stringify({ error: { message: 'mock provider exploded' } }), {
              status: 500, headers: { 'Content-Type': 'application/json' },
            });
          }
          const body = await req.json() as { input: string | string[] };
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          const vec = Array.from({ length: DIMS }, () => 0.1);
          return new Response(JSON.stringify({
            data: inputs.map((_, i) => ({ object: 'embedding', index: i, embedding: vec })),
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        // /v1/models probe shape.
        return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const home = mkdtempSync(join(tmpdir(), 'gbrain-3037-exit-'));
    const notes = mkdtempSync(join(tmpdir(), 'gbrain-3037-notes-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          database_path: join(home, '.gbrain', 'brain.pglite'),
          embedding_model: 'llama-server:test-model',
          embedding_dimensions: DIMS,
        }) + '\n',
      );
      writeFileSync(join(notes, 'note.md'), '# A note\n\nSome content to embed.\n');
      const env = {
        HOME: home,
        GBRAIN_HOME: home,
        LLAMA_SERVER_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      };

      const init = await runCli(['init', '--migrate-only'], env, 120_000);
      expect(init.exitCode).toBe(0);

      const imp = await runCli(['import', notes, '--no-embed'], env, 90_000);
      expect(imp.exitCode).toBe(0);

      // THE #3037 PIN: provider fails every embed call → the run must exit
      // non-zero. Pre-fix this exited 0 (result discarded by cli.ts).
      const failing = await runCli(['embed', '--stale'], env, 90_000);
      if (failing.exitCode === 0) {
        console.error('--- failing-embed stdout ---\n' + failing.stdout);
        console.error('--- failing-embed stderr ---\n' + failing.stderr);
      }
      expect(failing.exitCode).not.toBe(0);
      expect(failing.stderr).toMatch(/failed to embed/i);

      // Same brain, healthy provider: converges and exits 0 (failure exit is
      // not sticky; the failed chunks stayed NULL so --stale picks them up).
      mode = 'ok';
      const healthy = await runCli(['embed', '--stale'], env, 90_000);
      if (healthy.exitCode !== 0) {
        console.error('--- healthy-embed stdout ---\n' + healthy.stdout);
        console.error('--- healthy-embed stderr ---\n' + healthy.stderr);
      }
      expect(healthy.exitCode).toBe(0);
      expect(healthy.stdout + healthy.stderr).toMatch(/Embedded [1-9]\d* chunks/);
    } finally {
      server.stop(true);
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
      try { rmSync(notes, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 480_000);
});
