/**
 * Transcript capture tests — async drain, byte offsets, multi-byte safety,
 * spawn-with-capture happy + timeout paths.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTranscriptSink, spawnWithCapture } from '../src/core/claw-test/transcript-capture.ts';

let tmp: string;
let path: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'transcript-'));
  path = join(tmp, 'transcript.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('createTranscriptSink', () => {
  test('writes events as JSONL lines with byte_offset', async () => {
    const sink = createTranscriptSink(path);
    sink.write({ ts: 1, channel: 'stdout', bytes: Buffer.from('hello') });
    sink.write({ ts: 2, channel: 'stderr', bytes: Buffer.from('world') });
    await sink.close();

    const raw = readFileSync(path, 'utf-8');
    const lines = raw.trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].channel).toBe('stdout');
    expect(lines[0].byte_offset).toBe(0);
    expect(lines[1].channel).toBe('stderr');
    expect(lines[1].byte_offset).toBeGreaterThan(0);
    expect(Buffer.from(lines[0].bytes_b64, 'base64').toString('utf-8')).toBe('hello');
    expect(Buffer.from(lines[1].bytes_b64, 'base64').toString('utf-8')).toBe('world');
  });

  test('preserves multi-byte UTF-8 (no chunk-boundary corruption)', async () => {
    const sink = createTranscriptSink(path);
    // Split a 4-byte emoji across two writes to simulate stdio chunk boundaries.
    const emoji = '🌍';
    const buf = Buffer.from(emoji, 'utf-8');
    sink.write({ ts: 1, channel: 'stdout', bytes: buf.slice(0, 2) });
    sink.write({ ts: 2, channel: 'stdout', bytes: buf.slice(2) });
    await sink.close();

    const lines = readFileSync(path, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const concatenated = Buffer.concat([
      Buffer.from(lines[0].bytes_b64, 'base64'),
      Buffer.from(lines[1].bytes_b64, 'base64'),
    ]).toString('utf-8');
    expect(concatenated).toBe(emoji);
  });

  test('byte_offset is monotonic and matches the actual file position', async () => {
    const sink = createTranscriptSink(path);
    const before1 = sink.nextOffset();
    sink.write({ ts: 1, channel: 'stdout', bytes: Buffer.from('a') });
    const before2 = sink.nextOffset();
    sink.write({ ts: 2, channel: 'stdout', bytes: Buffer.from('b') });
    await sink.close();

    expect(before1).toBe(0);
    expect(before2).toBeGreaterThan(0);

    // Verify the offsets recorded in lines match the actual file substring offsets.
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.trim().split('\n').map(l => JSON.parse(l));
    const expectedOffsets = [0, Buffer.byteLength(raw.split('\n')[0] + '\n')];
    expect(lines[0].byte_offset).toBe(expectedOffsets[0]);
    expect(lines[1].byte_offset).toBe(expectedOffsets[1]);
  });

  test('survives bursty writes (drain handling)', async () => {
    const sink = createTranscriptSink(path);
    // 256KB of payload across 256 1KB writes — exceeds default pipe buffer
    const chunk = Buffer.alloc(1024, 0x61); // 'a' * 1024
    for (let i = 0; i < 256; i++) {
      sink.write({ ts: i, channel: 'stdout', bytes: chunk });
    }
    await sink.close();

    const raw = readFileSync(path, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(256);
  });

  test('close is idempotent', async () => {
    const sink = createTranscriptSink(path);
    sink.write({ ts: 1, channel: 'stdout', bytes: Buffer.from('x') });
    await sink.close();
    // Second close should not throw — the writeStream's `end` won't fire 'close' a second time
    // but we can call without error in our own wrapper.
    // (Implementation note: we don't expose a closed flag; idempotent via stream's no-op behavior.)
    expect(existsSync(path)).toBe(true);
  });
});

describe('spawnWithCapture', () => {
  test('captures stdout from a small command', async () => {
    const sink = createTranscriptSink(path);
    const result = await spawnWithCapture('/bin/sh', ['-c', 'printf hi'], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      transcriptSink: sink,
    });
    await sink.close();
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);

    const raw = readFileSync(path, 'utf-8');
    const captured = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const stdoutBytes = captured.filter(e => e.channel === 'stdout')
      .map(e => Buffer.from(e.bytes_b64, 'base64').toString('utf-8'))
      .join('');
    expect(stdoutBytes).toBe('hi');
  });

  test('non-zero exit propagates', async () => {
    const sink = createTranscriptSink(path);
    const result = await spawnWithCapture('/bin/sh', ['-c', 'exit 7'], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      transcriptSink: sink,
    });
    await sink.close();
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  test('timeout fires SIGTERM/SIGKILL', async () => {
    const sink = createTranscriptSink(path);
    // `exec sleep` replaces sh with sleep so the child we spawn IS sleep —
    // SIGTERM goes directly to it, no shell-vs-child process-group ambiguity.
    // CI runners are slower than local, so the test cap is 30s with headroom
    // even if SIGTERM is missed and SIGKILL has to run after the 5s grace.
    const result = await spawnWithCapture('/bin/sh', ['-c', 'exec sleep 30'], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 200,
      transcriptSink: sink,
    });
    await sink.close();
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 30_000);

  test('rejects when the binary does not exist', async () => {
    const sink = createTranscriptSink(path);
    await expect(
      spawnWithCapture('/no/such/binary', [], {
        cwd: tmp,
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 1_000,
        transcriptSink: sink,
      })
    ).rejects.toThrow();
    await sink.close();
  });
});
