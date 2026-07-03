/**
 * v0.43 (#2095) — `gbrain watch` SIGINT lifecycle. SERIAL: spawns a real CLI
 * subprocess with a tmpdir brain (the parallel unit shards flake on
 * concurrent subprocess spawns — same isolation rationale as
 * apply-migrations-pglite-spawn.serial.test.ts).
 */
import { describe, test, expect } from 'bun:test';

describe('gbrain watch — SIGINT lifecycle (real subprocess)', () => {
  test('SIGINT mid-stream closes the stream and exits cleanly (drain path, exit 0)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
    const { join, resolve } = await import('path');
    const { tmpdir } = await import('os');
    const REPO = resolve(import.meta.dir, '..');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-watch-sigint-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          database_path: join(home, '.gbrain', 'brain.pglite'),
          embedding_dimensions: 1536,
        }) + '\n',
      );
      // Piped stdin that NEVER reaches EOF — only SIGINT can end the stream.
      const proc = Bun.spawn(['bun', 'run', join(REPO, 'src', 'cli.ts'), 'watch'], {
        cwd: REPO,
        env: { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      proc.stdin.write('user: nothing relevant here\n');
      await proc.stdin.flush();
      // Readiness probe: watch prints "[watch] session <id> ready" on stderr
      // once engine + source resolution are done and the stdin loop is live.
      // A fixed sleep raced cold PGLite init (other tests budget 60s for it)
      // — SIGINT before the handler registers means default-disposition kill.
      const stderrChunks: string[] = [];
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 90_000;
      let ready = false;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        stderrChunks.push(decoder.decode(value, { stream: true }));
        if (stderrChunks.join('').includes('ready')) { ready = true; break; }
      }
      expect(ready).toBe(true);
      // Brief settle so the first turn's volunteerContext round-trip is in
      // flight or done, then interrupt mid-stream.
      await new Promise((r) => setTimeout(r, 500));
      proc.kill('SIGINT');
      const killer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 30_000);
      const exitCode = await proc.exited;
      clearTimeout(killer);
      // Drain the rest of stderr for the banner assertion.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stderrChunks.push(decoder.decode(value, { stream: true }));
      }
      const stderr = stderrChunks.join('');
      // Clean drain-then-exit: no force-exit banner, no SIGKILL (137), exit 0.
      expect(stderr).not.toContain('force-exiting');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
