/**
 * A5 (test-gap wave 1) — raw_transcript frontmatter path containment.
 * Pre-fix, readConversationBodyForParsing took an absolute raw_transcript
 * as-is and joined relative ones into sync.repo_path with no containment or
 * symlink resolution: an arbitrary local-file read driven by INGESTED page
 * frontmatter. Post-fix: repo-relative only, realpath contained in repoPath,
 * refusal falls back to readSummaryBody and warns with the refusal CLASS
 * only (never the attempted path). Mirrors the LocalStorage traversal block
 * in test/storage.test.ts.
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConversationBodyForParsing, readSummaryBody } from '../../src/core/conversation-parser/body.ts';
import type { Page } from '../../src/core/types.ts';

const realRepo = mkdtempSync(join(tmpdir(), 'cp-repo-real-'));
const linkParent = mkdtempSync(join(tmpdir(), 'cp-repo-link-'));
const linkedRepo = join(linkParent, 'repo');
symlinkSync(realRepo, linkedRepo);
const outside = mkdtempSync(join(tmpdir(), 'cp-outside-'));
writeFileSync(join(outside, 'secret.md'), 'OUTSIDE SECRET CONTENT\n');
mkdirSync(join(realRepo, 'transcripts', 'nested'), { recursive: true });
writeFileSync(join(realRepo, 'transcripts', 'nested', 'convo.md'), 'REAL TRANSCRIPT BODY\n');
// A symlink inside the repo escaping it (target exists → realpath resolves out).
symlinkSync(join(outside, 'secret.md'), join(realRepo, 'transcripts', 'escape.md'));

function fakeEngine(repoPath: string | null) {
  return { getConfig: async (k: string) => (k === 'sync.repo_path' ? repoPath : null) } as any;
}

function pageWith(rawTranscript: string | undefined): Page {
  return {
    slug: 'chat/fixture',
    type: 'conversation',
    title: 'Fixture',
    compiled_truth: 'SUMMARY COMPILED',
    timeline: 'SUMMARY TIMELINE',
    frontmatter: rawTranscript === undefined ? {} : { raw_transcript: rawTranscript },
  } as unknown as Page;
}

let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => { warnSpy = spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

afterAll(() => {
  rmSync(realRepo, { recursive: true, force: true });
  rmSync(linkParent, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const SUMMARY = 'SUMMARY COMPILED\n\nSUMMARY TIMELINE';

describe('raw_transcript containment', () => {
  test('absolute path is refused → summary fallback + one class-only warn', async () => {
    const body = await readConversationBodyForParsing(fakeEngine(realRepo), pageWith('/etc/passwd'));
    expect(body).toBe(SUMMARY);
    expect(body).not.toContain('root:');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain('raw_transcript refused');
    expect(msg).not.toContain('/etc/passwd');
  });

  test('relative traversal escaping the repo is refused', async () => {
    const body = await readConversationBodyForParsing(fakeEngine(realRepo), pageWith('../../../../../../etc/passwd'));
    expect(body).toBe(SUMMARY);
    expect(body).not.toContain('root:');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain('raw_transcript refused');
    expect(msg).not.toContain('etc/passwd');
  });

  test('in-repo symlink escaping the repo is refused', async () => {
    const body = await readConversationBodyForParsing(fakeEngine(realRepo), pageWith('transcripts/escape.md'));
    expect(body).toBe(SUMMARY);
    expect(body).not.toContain('OUTSIDE SECRET');
    expect(String(warnSpy.mock.calls[0][0])).toContain('raw_transcript refused');
  });

  test('legitimate nested relative sidecar reads', async () => {
    const body = await readConversationBodyForParsing(fakeEngine(realRepo), pageWith('transcripts/nested/convo.md'));
    expect(body).toBe('REAL TRANSCRIPT BODY');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('legitimate sidecar under a SYMLINKED repoPath reads (Conductor/macOS-tmp shape)', async () => {
    const body = await readConversationBodyForParsing(fakeEngine(linkedRepo), pageWith('transcripts/nested/convo.md'));
    expect(body).toBe('REAL TRANSCRIPT BODY');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('no repo_path configured → summary fallback, no read attempt', async () => {
    const body = await readConversationBodyForParsing(fakeEngine(null), pageWith('transcripts/nested/convo.md'));
    expect(body).toBe(SUMMARY);
  });
});

describe('readSummaryBody three-way join', () => {
  test('compiled only / timeline only / both', () => {
    expect(readSummaryBody({ compiled_truth: 'C', timeline: '' } as any)).toBe('C');
    expect(readSummaryBody({ compiled_truth: '', timeline: 'T' } as any)).toBe('T');
    expect(readSummaryBody({ compiled_truth: 'C', timeline: 'T' } as any)).toBe('C\n\nT');
  });
});
