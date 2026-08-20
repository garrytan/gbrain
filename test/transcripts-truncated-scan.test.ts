/**
 * A truncated adapter read (diag.truncated — e.g. codex's bounded head+tail
 * over an over-budget rollout) leaves an unscanned window in the file. The
 * run must surface it in the per-file outcome, count it, break cleanScan so
 * the --since last watermark never advances past sessions it never saw, and
 * print a one-line summary note.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { fmtSummary } from '../src/commands/transcripts.ts';
import type { TranscriptAdapter } from '../src/core/transcripts/types.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function stubAdapter(truncated: boolean): TranscriptAdapter {
  return {
    format: 'codex' as never,
    specTarget: 'codex' as never,
    detect: () => true,
    // eslint-disable-next-line require-yield
    parse: async function* () {
      return { bytesRead: 0, skippedLines: 0, truncated, sessions: 0 } as never;
    },
  };
}

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function run(truncated: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'gb-trunc-'));
  scratch.push(dir);
  const f = join(dir, 'rollout.jsonl');
  writeFileSync(f, '{"x":1}\n');
  return runTranscriptsIngest({} as never, {
    paths: [f],
    sourceId: 'default',
    adapters: [stubAdapter(truncated)],
  });
}

describe('truncated scans freeze the watermark', () => {
  test('diag.truncated=true → per-file truncated outcome, truncatedFiles count, cleanScan=false, summary note', async () => {
    const r = await run(true);
    expect(r.files[0].truncated).toBe(true);
    expect(r.truncatedFiles).toBe(1);
    expect(r.cleanScan).toBe(false);
    expect(fmtSummary(r)).toContain('TRUNCATED: 1 file(s)');
  });

  test('untruncated control: cleanScan holds and no TRUNCATED note prints', async () => {
    const r = await run(false);
    expect(r.files[0].truncated).toBe(false);
    expect(r.truncatedFiles).toBe(0);
    expect(r.cleanScan).toBe(true);
    expect(fmtSummary(r)).not.toContain('TRUNCATED');
  });
});
