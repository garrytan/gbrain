/**
 * `gbrain append --file` sizes the file before reading it (spec 6.2): a file
 * over the page ceiling is refused unread, one over the part cap is never read
 * whole (it streams into an upload session, or its upload-only flags are
 * refused first), and only a file within one call's cap is read as a string.
 * In process, through the appendFileIo seam; no engine is ever connected.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileIo, LOCAL_FRAME_MAX_BYTES, run } from '../src/cli/commands/append.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';
import type { CliDispatchContext } from '../src/cli/command-table.ts';

describe('gbrain append --file reads by size', () => {
  let dir: string;
  const reads: string[] = [];
  const original = appendFileIo.readFileSync;
  let connects = 0;
  const ctx = { connectEngine: async () => { connects++; throw new Error('no engine in this test'); } } as unknown as CliDispatchContext;

  async function append(args: string[]): Promise<{ code: number; stderr: string }> {
    _resetCliExitVerdictForTests();
    const priorExitCode = process.exitCode;
    let stderr = '';
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    try { await withEnv({ GBRAIN_HOME: dir, HOME: dir }, () => run(args, ctx)); } finally { process.stderr.write = write; }
    const code = currentExitCode();
    _resetCliExitVerdictForTests();
    process.exitCode = priorExitCode ?? 0;
    return { code, stderr };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-append-file-read-'));
    appendFileIo.readFileSync = (path: string) => { reads.push(path); return original(path); };
  });
  afterEach(() => { reads.length = 0; connects = 0; });
  afterAll(() => {
    appendFileIo.readFileSync = original;
    _resetCliExitVerdictForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a file over the page ceiling is refused before it is read or a brain is opened', async () => {
    const path = join(dir, 'huge.md');
    writeFileSync(path, '');
    truncateSync(path, PAGE_MAX_BYTES + 1);
    const result = await append(['notes/log', '--file', path]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('request_too_large');
    expect(result.stderr).toContain('nothing was read or appended');
    expect(reads).toEqual([]);
    expect(connects).toBe(0);
  });

  test('a file over the part cap is never read whole: its upload-only flags are refused first', async () => {
    const path = join(dir, 'over-cap.md');
    writeFileSync(path, '');
    truncateSync(path, LOCAL_FRAME_MAX_BYTES + 1);
    const result = await append(['notes/log', '--file', path, '--region', 'truth']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--region apply only to an append whose call fits');
    expect(reads).toEqual([]);
    expect(connects).toBe(0);
  });

  test('a file within the part cap is read whole once, through the seam', async () => {
    const path = join(dir, 'small.md');
    writeFileSync(path, '- one message\n');
    await append(['notes/log', '--file', path]);
    expect(reads).toEqual([path]);
  });
});
