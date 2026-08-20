/**
 * writeStdoutFinal delivery contract (#3423).
 *
 * process.stdout.write queues pipe writes in a native writer that only pushes
 * to the fd while the process stays alive; flushThenExit's aliveness grace is
 * fixed, so a payload larger than the 64KiB kernel pipe buffer piped to a
 * reader that drains slower than the grace lost its tail with exit 0. The
 * production shape: an agent's verify-read of a large page came back cut at
 * exactly 65,536 bytes, the tail (where the fresh edit lives) missing, and the
 * agent concluded the save never landed. writeStdoutFinal awaits Bun.write on
 * Bun.stdout, which resolves only after the fd accepted every byte, so the
 * subsequent exit cannot drop anything regardless of reader pace.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = join(import.meta.dir, '..', 'src', 'core', 'cli-force-exit.ts');
const PAYLOAD_BYTES = 200_001; // > 3x the 64KiB kernel pipe buffer

describe('writeStdoutFinal (#3423)', () => {
  test('a 200KB payload survives a slow pipe reader and an immediate process.exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-delivery-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { writeStdoutFinal } from ${JSON.stringify(HELPER)};\n` +
        `await writeStdoutFinal('x'.repeat(${PAYLOAD_BYTES}));\n` +
        `process.exit(0);\n`,
    );
    try {
      const proc = Bun.spawn({ cmd: [process.execPath, script], stdout: 'pipe', stderr: 'inherit' });
      // Slow reader: leave the pipe undrained past the kernel buffer AND the
      // exit grace. Queued-write behavior truncated here at exactly 65,536
      // bytes with exit 0; awaited delivery blocks the child until we drain.
      await new Promise((r) => setTimeout(r, 700));
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(out.length).toBe(PAYLOAD_BYTES);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('a reader that closes early does not crash the writer (EPIPE swallowed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-epipe-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { writeStdoutFinal } from ${JSON.stringify(HELPER)};\n` +
        `await writeStdoutFinal('x'.repeat(${PAYLOAD_BYTES}));\n` +
        `process.exit(0);\n`,
    );
    try {
      const proc = Bun.spawn({ cmd: [process.execPath, script], stdout: 'pipe', stderr: 'inherit' });
      // Close our end after the first chunk arrives — the child must still
      // exit 0 (the operation succeeded; delivery to a gone reader is moot).
      const reader = proc.stdout.getReader();
      await reader.read();
      await reader.cancel();
      const code = await proc.exited;
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
