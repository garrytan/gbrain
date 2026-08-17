/**
 * gbrain#4149 — the per-format byte caps get a validated, checkpoint-aware
 * escape hatch instead of being unreachable from the CLI.
 *
 * Pre-fix (red on master at the assertions): ParseSessionsOpts.maxBytes
 * existed but ingest.ts never threaded it, so `gbrain transcripts ingest`
 * users hit the Hermes 512MB store guard with no recourse; --max-bytes was
 * an unknown flag; and a --since last checkpoint carried no cap dimension.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { parseIngestArgs, ingestCheckpointFingerprintInput } from '../src/commands/transcripts.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { fingerprint } from '../src/core/op-checkpoint.ts';
import type { TranscriptAdapter, ParseSessionsOpts } from '../src/core/transcripts/types.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('--max-bytes CLI validation (gbrain#4149)', () => {
  test('accepts plain bytes and kb/mb/gb forms', () => {
    expect((parseIngestArgs(['a.jsonl', '--max-bytes', '800000000']) as any).maxBytes).toBe(800_000_000);
    expect((parseIngestArgs(['a.jsonl', '--max-bytes', '512mb']) as any).maxBytes).toBe(512 * 1024 ** 2);
    expect((parseIngestArgs(['a.jsonl', '--max-bytes', '4gb']) as any).maxBytes).toBe(4 * 1024 ** 3);
    expect((parseIngestArgs(['a.jsonl', '--max-bytes', '1.5gb']) as any).maxBytes).toBe(Math.floor(1.5 * 1024 ** 3));
  });

  test('rejects garbage, zero, and negatives loudly', () => {
    expect((parseIngestArgs(['a.jsonl', '--max-bytes', 'lots']) as any).error).toContain('max-bytes');
    expect((parseIngestArgs(['a.jsonl', '--max-bytes', '0']) as any).error).toContain('positive');
    expect((parseIngestArgs(['a.jsonl', '--max-bytes', '-5']) as any).error).toContain('max-bytes');
    expect((parseIngestArgs(['a.jsonl', '--max-bytes']) as any).error).toContain('max-bytes');
  });

  test('omission leaves maxBytes undefined (adapter-native defaults stay in charge)', () => {
    expect((parseIngestArgs(['a.jsonl']) as any).maxBytes).toBeUndefined();
  });
});

describe('cap threading to adapters (gbrain#4149)', () => {
  function stubAdapter(seen: Array<ParseSessionsOpts | undefined>): TranscriptAdapter {
    return {
      format: 'claude-code' as never,
      specTarget: 'claude-code' as never,
      detect: () => true,
      // eslint-disable-next-line require-yield
      parse: async function* (_path: string, opts?: ParseSessionsOpts) {
        seen.push(opts);
        return { truncated: false } as never;
      },
    };
  }

  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function runWith(maxBytes: number | undefined, seen: Array<ParseSessionsOpts | undefined>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gb4149-'));
    scratchDirs.push(dir);
    const f = join(dir, 's.jsonl');
    writeFileSync(f, '{"x":1}\n');
    await runTranscriptsIngest({} as never, {
      paths: [f],
      dryRun: true,
      sourceId: 'default',
      maxBytes,
      adapters: [stubAdapter(seen)],
    });
  }

  test('an explicit cap reaches adapter.parse', async () => {
    const seen: Array<ParseSessionsOpts | undefined> = [];
    await runWith(123_456, seen);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxBytes).toBe(123_456);
  });

  test('omission passes NO opts — each adapter keeps its format-specific default', async () => {
    const seen: Array<ParseSessionsOpts | undefined> = [];
    await runWith(undefined, seen);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeUndefined();
  });
});

describe('checkpoint fingerprint carries the cap (gbrain#4149)', () => {
  const base = { sourceId: 'default', pathspec: '~/.hermes/state.db', format: 'hermes', version: 'v3' };

  test('auto vs explicit caps produce different fingerprints (no silent watermark reuse)', () => {
    const auto = fingerprint(ingestCheckpointFingerprintInput(base));
    const capped = fingerprint(ingestCheckpointFingerprintInput({ ...base, maxBytes: 4 * 1024 ** 3 }));
    const cappedOther = fingerprint(ingestCheckpointFingerprintInput({ ...base, maxBytes: 512 * 1024 ** 2 }));
    expect(auto).not.toBe(capped);
    expect(capped).not.toBe(cappedOther);
  });

  test('the default (no-cap) path keeps the LEGACY 4-key fingerprint — existing watermarks stay valid at upgrade', () => {
    // Review finding (multi-specialist confirmed): an unconditional
    // maxBytes:'auto' key would orphan every pre-#4149 checkpoint and force
    // a silent one-time full rescan on the first post-upgrade --since last.
    const auto = fingerprint(ingestCheckpointFingerprintInput(base));
    const legacy = fingerprint({
      sourceId: base.sourceId,
      pathspec: base.pathspec,
      format: base.format,
      version: base.version,
    });
    expect(auto).toBe(legacy);
  });

  test('the same cap is stable (checkpoint resume still works within one cap)', () => {
    const a = fingerprint(ingestCheckpointFingerprintInput({ ...base, maxBytes: 1024 }));
    const b = fingerprint(ingestCheckpointFingerprintInput({ ...base, maxBytes: 1024 }));
    expect(a).toBe(b);
  });
});
