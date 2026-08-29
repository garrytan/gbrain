/**
 * writeStdoutFinal delivery contract (#3423) + installStdoutPipeDelivery
 * interposer (#4383).
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
 *
 * #4383 extends the same delivery guarantee to CLI_ONLY handlers that emit
 * payloads through bare process.stdout.write (advisor --json, eval outcomes,
 * agent results, ...) AND through console.log (orphans --json, ...): the
 * interposer serializes both through one fd-1 write chain, and flushThenExit
 * drains the chain's tail before its fence + grace. Verified on this branch:
 * WITHOUT the interposer, the process.stdout.write shape below truncates at
 * exactly 65,536 bytes with exit 0 against a reader slower than the fence
 * guard + grace — and once anything initializes the process.stdout wrapper
 * (any isTTY read; the real CLI does this long before payloads print), fd 1
 * goes O_NONBLOCK and the console.log shape truncates the same way.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  writeChunkSync,
  resolveStdoutDrainDeadlineMs,
  currentExitCode,
  _resetCliExitVerdictForTests,
} from '../src/core/cli-force-exit.ts';

const HELPER = join(import.meta.dir, '..', 'src', 'core', 'cli-force-exit.ts');
const PAYLOAD_BYTES = 200_001; // > 3x the 64KiB kernel pipe buffer

/**
 * Run `script` with its stdout piped into a genuinely slow reader — a kernel
 * pipe nobody reads for `sleepSeconds`. Bun.spawn's own stdout:'pipe' eagerly
 * drains into the parent, so it can never model a slow reader by itself; the
 * inner `sleep N; cat` block is what leaves the pipe undrained past the
 * 64KiB kernel buffer and past flushThenExit's guard + grace windows.
 */
async function runViaSlowReader(
  script: string,
  sleepSeconds: number,
): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn({
    cmd: ['sh', '-c', `"${process.execPath}" "${script}" | { sleep ${sleepSeconds}; cat; }`],
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { out, code };
}

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

describe('installStdoutPipeDelivery (#4383)', () => {
  test('interposed: a 200KB process.stdout.write payload (CLI_ONLY shape) survives a reader slower than fence guard + grace', async () => {
    // The reproducible truncation class on this branch: CLI_ONLY handlers
    // (advisor --json, eval-brainbench, eval-compare, agent results) emit via
    // bare process.stdout.write; against a reader that drains slower than
    // flushThenExit's 2s fence guard + 250ms grace, the queued native writer
    // lost everything past 65,536 bytes with exit 0. Interposed, the write
    // serializes through the awaited Bun.write chain and cannot truncate.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-interpose-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery, flushThenExit } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        `process.stdout.write('x'.repeat(${PAYLOAD_BYTES - 1}) + '\\n');\n` +
        `flushThenExit(0);\n`,
    );
    try {
      // 2.6s > FLUSH_GUARD_MS (2s) + FLUSH_GRACE_PIPE_MS (250ms): outlasts
      // every aliveness window the pre-fix exit seam offered.
      const { out, code } = await runViaSlowReader(script, 2.6);
      expect(out.length).toBe(PAYLOAD_BYTES);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('interposed: a CLI_ONLY-shaped console.log --json payload survives a slow reader', async () => {
    // The area's named shape (`orphans --json` console.logs its whole result).
    // Bun's console.log does NOT route through process.stdout.write — and once
    // the process.stdout wrapper is initialized (which installing the
    // interposer, or ANY isTTY read in the real CLI, does), fd 1 goes
    // O_NONBLOCK and console.log's own writer EAGAINs the payload into a
    // queue that exit discards: this exact test truncated mid-string before
    // the interposer learned to reroute console.log through the chain.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-consolelog-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery, flushThenExit } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        `const result = { total_orphans: 1, orphans: [{ slug: 'notes/example', reason: 'x'.repeat(${PAYLOAD_BYTES}) }] };\n` +
        `console.log(JSON.stringify(result, null, 2));\n` +
        `flushThenExit(0);\n`,
    );
    try {
      const { out, code } = await runViaSlowReader(script, 2.6);
      const parsed = JSON.parse(out);
      expect(parsed.orphans[0].reason.length).toBe(PAYLOAD_BYTES);
      expect(out.endsWith('}\n')).toBe(true);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('interposed: a reader that closes early does not hang or crash (EPIPE swallowed)', async () => {
    // `gbrain <cmd> --json | head -c 1000`: head closes the pipe after 1000
    // bytes. The interposed blocking write gets EPIPE mid-payload; it must be
    // swallowed (partial delivery to a gone reader is not an op failure) and
    // the chain's tail must still settle so flushThenExit reaches its fence —
    // exit 0, promptly, no hang. PIPESTATUS[0] surfaces the child's own code.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-interpose-epipe-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery, flushThenExit } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        `process.stdout.write('x'.repeat(4_000_000));\n` +
        `flushThenExit(0);\n`,
    );
    try {
      const t0 = Date.now();
      const proc = Bun.spawn({
        cmd: [
          'bash',
          '-c',
          `"${process.execPath}" "${script}" | head -c 1000 > /dev/null; echo "\${PIPESTATUS[0]}"`,
        ],
        stdout: 'pipe',
        stderr: 'inherit',
      });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(out.trim()).toBe('0'); // the CLI child exited 0 despite EPIPE
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(10_000); // no hang on a gone reader
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('interposed: ordering preserved across chained writes and the writeStdoutFinal tail join', async () => {
    // Three 90KB blocks — two via interposed process.stdout.write, the third
    // via writeStdoutFinal (which joins the SAME tail) — must arrive in call
    // order, byte-exact, through a slow reader. A second, unserialized writer
    // would interleave or reorder the blocks.
    const BLOCK = 90_000;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-interpose-order-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery, writeStdoutFinal, flushThenExit } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        `process.stdout.write('A'.repeat(${BLOCK}));\n` +
        `process.stdout.write('B'.repeat(${BLOCK}));\n` +
        `await writeStdoutFinal('C'.repeat(${BLOCK}) + '\\n');\n` +
        `flushThenExit(0);\n`,
    );
    try {
      const { out, code } = await runViaSlowReader(script, 1);
      expect(out).toBe('A'.repeat(BLOCK) + 'B'.repeat(BLOCK) + 'C'.repeat(BLOCK) + '\n');
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('bounded tail drain (D2): a stalled-open reader cannot hang the exit past GBRAIN_STDOUT_DRAIN_DEADLINE_MS', async () => {
    // The tail drain is EPIPE-settled when a reader DIES, but a reader that
    // stays open and never drains used to hang the exit forever. With a tiny
    // env deadline the child must exit (code 0, one-line stderr note) long
    // before the never-draining reader (`sleep 4`, which reads nothing)
    // releases the pipe at ~4s. The harness stamps its wall-clock-to-exit and
    // code into a file since its stdout is wedged by construction.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-drain-deadline-'));
    const script = join(dir, 'emit.ts');
    const stamp = join(dir, 'stamp.json');
    const errFile = join(dir, 'stderr.txt');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery, flushThenExit } from ${JSON.stringify(HELPER)};\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `installStdoutPipeDelivery();\n` +
        `const t0 = Date.now();\n` +
        `process.stdout.write('x'.repeat(4_000_000));\n` + // wedges past the 64KiB pipe buffer
        `flushThenExit(0, {\n` +
        `  guardMs: 400,\n` +
        `  graceMs: 100,\n` +
        `  exit: (c) => {\n` +
        `    writeFileSync(${JSON.stringify(stamp)}, JSON.stringify({ ms: Date.now() - t0, code: c }));\n` +
        `    process.exit(c);\n` +
        `  },\n` +
        `});\n`,
    );
    try {
      const proc = Bun.spawn({
        cmd: ['sh', '-c', `"${process.execPath}" "${script}" 2> "${errFile}" | sleep 4`],
        env: { ...process.env, GBRAIN_STDOUT_DRAIN_DEADLINE_MS: '500' },
        stdout: 'ignore',
        stderr: 'inherit',
      });
      await proc.exited;
      const stamped = JSON.parse(readFileSync(stamp, 'utf8')) as { ms: number; code: number };
      expect(stamped.code).toBe(0);
      // Deadline 500ms + fence guard 400ms + grace 100ms ≈ 1s; the pre-fix
      // behavior only exits when sleep dies at ~4s (EPIPE settles the tail).
      expect(stamped.ms).toBeLessThan(3_000);
      const err = readFileSync(errFile, 'utf8');
      expect(err).toContain('stdout tail drain exceeded 500ms');
      expect(err).toContain('GBRAIN_STDOUT_DRAIN_DEADLINE_MS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('direct process.exit(2) behind an EAGAIN-deferred bulk write delivers BOTH payloads in order (queued-tail sync drain)', async () => {
    // #4383 residual: the CLI's validation paths (exit-2 JSON error
    // envelopes — e.g. the bad .gbrain-source pin path in code-callers)
    // print through the interposed console.log / process.stdout.write and
    // then call process.exit(2) DIRECTLY, never reaching flushThenExit. When
    // a prior bulk write EAGAIN-defers into the queue, the envelope appends
    // BEHIND it — and the pre-fix direct exit discarded the whole queued
    // tail: against a slow reader this exact shape delivered only the first
    // 64KiB of the bulk payload, no envelope, exit 2. The patched
    // process.exit drains the queue synchronously (blocking through reader
    // backpressure) before the real exit.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-direct-exit-'));
    const script = join(dir, 'emit.ts');
    const envelope = JSON.stringify({ error: { code: 'invalid_source_pin', message: 'not a source' } });
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        // Bulk payload > 64KiB: fills the kernel pipe buffer, EAGAIN-defers
        // its tail into the queue.
        `process.stdout.write('x'.repeat(${PAYLOAD_BYTES}));\n` +
        // The victim shape: a small JSON envelope via console.log queues
        // behind the deferred bulk write...
        `console.log(${JSON.stringify(envelope)});\n` +
        // ...and a DIRECT exit (no flushThenExit) must not discard the tail.
        `process.exit(2);\n`,
    );
    const codeFile = join(dir, 'child-code.txt');
    try {
      // Slow reader: nothing drains for 1s — the sync drain must block
      // through the backpressure instead of truncating. The pipeline's own
      // exit code is cat's (always 0); PIPESTATUS[0] banks the CLI child's.
      const proc = Bun.spawn({
        cmd: [
          'bash',
          '-c',
          `"${process.execPath}" "${script}" | { sleep 1; cat; }; echo "\${PIPESTATUS[0]}" > "${codeFile}"`,
        ],
        stdout: 'pipe',
        stderr: 'inherit',
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out.length).toBe(PAYLOAD_BYTES + envelope.length + 1);
      expect(out.slice(0, PAYLOAD_BYTES)).toBe('x'.repeat(PAYLOAD_BYTES));
      expect(out.slice(PAYLOAD_BYTES)).toBe(envelope + '\n');
      expect(readFileSync(codeFile, 'utf8').trim()).toBe('2'); // the direct exit's code survived
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('direct process.exit: a stalled-open reader cannot wedge the sync drain past GBRAIN_STDOUT_DRAIN_DEADLINE_MS', async () => {
    // Same D2 cap as the async drain, now on the synchronous direct-exit
    // path: a reader that stays open and never drains must not block the
    // patched exit forever. With a 500ms env deadline the drain gives up,
    // prints the one-line stderr note, and the real exit proceeds — the
    // process.on('exit') stamp (fires inside the real exit, AFTER the drain)
    // captures wall-clock-to-exit and the preserved code, since stdout is
    // wedged by construction.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-direct-exit-deadline-'));
    const script = join(dir, 'emit.ts');
    const stamp = join(dir, 'stamp.json');
    const errFile = join(dir, 'stderr.txt');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery } from ${JSON.stringify(HELPER)};\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `installStdoutPipeDelivery();\n` +
        `const t0 = Date.now();\n` +
        `process.on('exit', (code) => {\n` +
        `  writeFileSync(${JSON.stringify(stamp)}, JSON.stringify({ ms: Date.now() - t0, code }));\n` +
        `});\n` +
        `process.stdout.write('x'.repeat(4_000_000));\n` + // wedges past the 64KiB pipe buffer
        `process.exit(3);\n`,
    );
    try {
      const proc = Bun.spawn({
        cmd: ['sh', '-c', `"${process.execPath}" "${script}" 2> "${errFile}" | sleep 4`],
        env: { ...process.env, GBRAIN_STDOUT_DRAIN_DEADLINE_MS: '500' },
        stdout: 'ignore',
        stderr: 'inherit',
      });
      await proc.exited;
      const stamped = JSON.parse(readFileSync(stamp, 'utf8')) as { ms: number; code: number };
      expect(stamped.code).toBe(3); // the direct exit's code is preserved
      // Deadline 500ms; the pre-cap behavior only exits when sleep dies at
      // ~4s (EPIPE settles the queue).
      expect(stamped.ms).toBeLessThan(3_000);
      const err = readFileSync(errFile, 'utf8');
      expect(err).toContain('stdout tail drain exceeded 500ms');
      expect(err).toContain('GBRAIN_STDOUT_DRAIN_DEADLINE_MS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('interposed: multi-console.log help text survives an immediate raw process.exit (sync fast path)', async () => {
    // The regression the chain must NOT introduce: hundreds of help/usage
    // sites `console.log(...)` several lines and then call process.exit(1)
    // synchronously — no microtask ever runs, so a chain that defers delivery
    // would strand every line after the first. The chain's fast path delivers
    // synchronously inside each call while the chain is idle and the pipe has
    // room, so all lines must arrive even though the exit seam never runs.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stdout-interpose-usage-'));
    const script = join(dir, 'emit.ts');
    writeFileSync(
      script,
      `import { installStdoutPipeDelivery } from ${JSON.stringify(HELPER)};\n` +
        `installStdoutPipeDelivery();\n` +
        `console.log('Usage: gbrain frob [options]');\n` +
        `console.log('');\n` +
        `console.log('  --json   emit JSON');\n` +
        `console.log('  --help   this text');\n` +
        `process.exit(7);\n`,
    );
    try {
      const proc = Bun.spawn({ cmd: [process.execPath, script], stdout: 'pipe', stderr: 'inherit' });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(out).toBe('Usage: gbrain frob [options]\n\n  --json   emit JSON\n  --help   this text\n');
      expect(code).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('resolveStdoutDrainDeadlineMs (D2)', () => {
  const KEY = 'GBRAIN_STDOUT_DRAIN_DEADLINE_MS';

  test('default is a generous 120s cap', async () => {
    await withEnv({ [KEY]: undefined }, () => {
      expect(resolveStdoutDrainDeadlineMs()).toBe(120_000);
    });
  });

  test('env override wins; 0 disables the cap; junk falls back to the default', async () => {
    await withEnv({ [KEY]: '500' }, () => {
      expect(resolveStdoutDrainDeadlineMs()).toBe(500);
    });
    await withEnv({ [KEY]: '0' }, () => {
      expect(resolveStdoutDrainDeadlineMs()).toBe(0);
    });
    await withEnv({ [KEY]: 'not-a-number' }, () => {
      expect(resolveStdoutDrainDeadlineMs()).toBe(120_000);
    });
    await withEnv({ [KEY]: '-1' }, () => {
      expect(resolveStdoutDrainDeadlineMs()).toBe(120_000);
    });
  });
});

describe('writeChunkSync errno honesty (D2)', () => {
  function errnoThrower(code: string): (fd: number, buf: Buffer, off: number, len: number) => number {
    return () => {
      const e = new Error(code) as NodeJS.ErrnoException;
      e.code = code;
      throw e;
    };
  }

  /** Run `fn` with process.stderr.write captured and the verdict channel clean. */
  function withCapturedStderr(fn: () => void): { stderr: string; exitCode: number } {
    const prevExitCode = process.exitCode;
    const realWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    _resetCliExitVerdictForTests();
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;
    try {
      fn();
      return { stderr: captured, exitCode: currentExitCode() };
    } finally {
      process.stderr.write = realWrite;
      _resetCliExitVerdictForTests();
      // `?? 0`: restoring a captured `undefined` does not clear an already-set
      // exitCode in Bun — the mirror write from setCliExitVerdict(1) would
      // leak and fail the whole test-file run with 0 failing tests.
      process.exitCode = prevExitCode ?? 0;
    }
  }

  test('EPIPE still finishes the chain silently with exit verdict untouched (gone reader)', () => {
    const buf = Buffer.from('payload');
    const { stderr, exitCode } = withCapturedStderr(() => {
      expect(writeChunkSync(buf, 0, errnoThrower('EPIPE'))).toBe('done');
    });
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('EAGAIN / EINTR return the resume offset (retryable, no warning, no verdict)', () => {
    const buf = Buffer.from('payload');
    const { stderr, exitCode } = withCapturedStderr(() => {
      expect(writeChunkSync(buf, 3, errnoThrower('EAGAIN'))).toBe(3);
      expect(writeChunkSync(buf, 5, errnoThrower('EINTR'))).toBe(5);
    });
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('ENOSPC warns on stderr naming the errno and sets a nonzero exit verdict', () => {
    const buf = Buffer.from('payload');
    const { stderr, exitCode } = withCapturedStderr(() => {
      // Two bytes land, then the disk fills: the chain must still finish
      // ('done'), but never silently with exit 0.
      let calls = 0;
      const partialThenEnospc = (fd: number, b: Buffer, off: number, len: number): number => {
        calls += 1;
        if (calls === 1) return 2;
        return errnoThrower('ENOSPC')(fd, b, off, len);
      };
      expect(writeChunkSync(buf, 0, partialThenEnospc)).toBe('done');
    });
    expect(stderr).toContain('ENOSPC');
    expect(stderr).toContain('at byte 2 of 7');
    expect(stderr).toContain('output truncated');
    expect(exitCode).toBe(1);
  });

  test('EIO warns and flips the verdict too — any non-EPIPE errno is an honest failure', () => {
    const buf = Buffer.from('payload');
    const { stderr, exitCode } = withCapturedStderr(() => {
      expect(writeChunkSync(buf, 0, errnoThrower('EIO'))).toBe('done');
    });
    expect(stderr).toContain('EIO');
    expect(exitCode).toBe(1);
  });

  test('an errno-less throw still warns and flips the verdict (never silent-truncate)', () => {
    const buf = Buffer.from('payload');
    const { stderr, exitCode } = withCapturedStderr(() => {
      expect(
        writeChunkSync(buf, 0, () => {
          throw new Error('mystery failure');
        }),
      ).toBe('done');
    });
    expect(stderr).toContain('unknown errno');
    expect(exitCode).toBe(1);
  });
});
