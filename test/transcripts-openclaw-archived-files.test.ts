/**
 * GST-2768 PR 2: OpenClaw archives a session file when it is reset (`<id>.jsonl.reset.<stamp>`, plain JSONL) or
 * deleted (`<id>.jsonl.deleted.<stamp>.<hex>.zst`, zstd-compressed JSONL; recorded from OpenClaw 2026.11.3). Both
 * keep the live file's line format. Discovery lists them and the adapter parses them, so the file reader archives
 * a conversation whose live file is gone. Checkpoint files stay excluded.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverTranscriptFiles } from '../src/core/transcripts/discover.ts';
import { openclawAdapter } from '../src/core/transcripts/openclaw.ts';
import type { FileDiagnostics, ParsedSession } from '../src/core/transcripts/types.ts';

const AGENT_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'agent-session.jsonl');
const root = mkdtempSync(join(tmpdir(), 'openclaw-archived-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function drain(gen: AsyncGenerator<ParsedSession, FileDiagnostics>): Promise<ParsedSession[]> {
  const out: ParsedSession[] = [];
  for (let r = await gen.next(); !r.done; r = await gen.next()) out.push(r.value);
  return out;
}

describe('openclaw archived session files', () => {
  const text = readFileSync(AGENT_FIXTURE, 'utf8');
  const live = join(root, 'live-1.jsonl');
  const reset = join(root, 'reset-1.jsonl.reset.2026-11-15T05-40-00.000Z');
  const deleted = join(root, 'deleted-1.jsonl.deleted.2026-11-15T05-43-50.473Z.9f3a1c0d4e5b6a7f8091a2b3c4d5e6f7.zst');
  const checkpoint = join(root, 'live-1.checkpoint.11111111-aaaa-bbbb-cccc-222222222222.jsonl');
  writeFileSync(live, text);
  writeFileSync(reset, text);
  writeFileSync(deleted, Bun.zstdCompressSync(Buffer.from(text)));
  writeFileSync(checkpoint, text);

  test('archive discovery lists the live, reset and deleted files and skips the checkpoint', () => {
    const found = discoverTranscriptFiles([{ format: 'openclaw', root, extension: '.jsonl' }], { includeArchived: true }).map(d => d.path).sort();
    expect(found).toEqual([deleted, live, reset].sort());
  });

  test('plain discovery (transcripts ingest) lists only the live file, so one session never imports twice', () => {
    const found = discoverTranscriptFiles([{ format: 'openclaw', root, extension: '.jsonl' }]).map(d => d.path);
    expect(found).toEqual([live]);
  });

  test('detect accepts both archived variants', () => {
    expect(openclawAdapter.detect(reset, Buffer.from(text.slice(0, 4096)))).toBe(true);
    expect(openclawAdapter.detect(deleted, readFileSync(deleted).subarray(0, 4096))).toBe(true);
    expect(openclawAdapter.detect(checkpoint, Buffer.from(text.slice(0, 4096)))).toBe(false);
  });

  test('the reset and the zstd deleted file parse to the same messages as the live file', async () => {
    const [base] = await drain(openclawAdapter.parse(live));
    expect(base?.meta.sessionId).toBeTruthy();
    for (const path of [reset, deleted]) {
      const [s] = await drain(openclawAdapter.parse(path));
      expect(s?.meta.sessionId).toBe(base!.meta.sessionId);
      expect(s?.messages).toEqual(base!.messages);
    }
  });
});
