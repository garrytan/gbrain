/**
 * #3911 — relative `raw_transcript` resolves against the page's OWNING
 * source's local_path (not just the brain-global sync.repo_path), and
 * `../` traversal outside the resolved root is rejected. Follow-up: an
 * ABSOLUTE raw_transcript is the same untrusted frontmatter — it must land
 * inside a registered root (source local_path or sync.repo_path) or it is
 * rejected too (no /etc/passwd reads via synced frontmatter).
 *
 * Pre-fix: readConversationBodyForParsing only consulted sync.repo_path, so
 * a multi-source brain whose transcripts live per-source silently read the
 * wrong file (or fell back to the summary body), and an escaping relative
 * path could read arbitrary host files.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConversationBodyForParsing } from '../src/core/conversation-parser/body.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';

let root: string;
let sourceRepo: string;
let globalRepo: string;
let outsideDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-3911-'));
  sourceRepo = join(root, 'source-repo');
  globalRepo = join(root, 'global-repo');
  outsideDir = join(root, 'outside');
  mkdirSync(join(sourceRepo, 'transcripts'), { recursive: true });
  mkdirSync(join(globalRepo, 'transcripts'), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(sourceRepo, 'transcripts', 'meeting.txt'), 'SOURCE transcript body\n');
  writeFileSync(join(globalRepo, 'transcripts', 'meeting.txt'), 'GLOBAL transcript body\n');
  writeFileSync(join(outsideDir, 'secret.txt'), 'OUTSIDE THE ROOT\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Stub engine: `sources` row lookup + sync.repo_path config. */
function stubEngine(opts: {
  sourceLocalPath?: string | null;
  repoPath?: string | null;
  sourceExists?: boolean;
}): BrainEngine {
  return {
    executeRaw: async (_sql: string, params?: unknown[]) => {
      if (opts.sourceExists === false) return [];
      return [
        {
          id: (params?.[0] as string) ?? 'default',
          name: 'stub',
          local_path: opts.sourceLocalPath ?? null,
          last_commit: null,
          last_sync_at: null,
          config: {},
          created_at: new Date(),
          contextual_retrieval_mode: null,
          trust_frontmatter_overrides: false,
        },
      ];
    },
    getConfig: async (key: string) =>
      key === 'sync.repo_path' ? (opts.repoPath ?? null) : null,
  } as unknown as BrainEngine;
}

function pageWith(rawTranscript: string, sourceId = 'vault'): Page {
  return {
    slug: 'meetings/m1',
    title: 'M1',
    source_id: sourceId,
    compiled_truth: 'SUMMARY body',
    timeline: '',
    frontmatter: { raw_transcript: rawTranscript },
  } as unknown as Page;
}

describe('#3911 raw_transcript source-root resolution', () => {
  test('relative path resolves against the OWNING source local_path, not sync.repo_path', async () => {
    const engine = stubEngine({ sourceLocalPath: sourceRepo, repoPath: globalRepo });
    const body = await readConversationBodyForParsing(engine, pageWith('transcripts/meeting.txt'));
    expect(body).toBe('SOURCE transcript body');
  });

  test('escaping relative path (../) outside the source root is rejected — summary body wins', async () => {
    const engine = stubEngine({ sourceLocalPath: sourceRepo, repoPath: globalRepo });
    const body = await readConversationBodyForParsing(
      engine,
      pageWith('../outside/secret.txt'),
    );
    expect(body).toBe('SUMMARY body');
    expect(body).not.toContain('OUTSIDE THE ROOT');
  });

  test('sync.repo_path fallback still works when the source row has no local_path', async () => {
    const engine = stubEngine({ sourceLocalPath: null, repoPath: globalRepo });
    const body = await readConversationBodyForParsing(engine, pageWith('transcripts/meeting.txt'));
    expect(body).toBe('GLOBAL transcript body');
  });

  test('sync.repo_path fallback also works when the source row is missing entirely', async () => {
    const engine = stubEngine({ sourceExists: false, repoPath: globalRepo });
    const body = await readConversationBodyForParsing(engine, pageWith('transcripts/meeting.txt'));
    expect(body).toBe('GLOBAL transcript body');
  });

  test('escaping relative path under the repo_path fallback is rejected too', async () => {
    const engine = stubEngine({ sourceLocalPath: null, repoPath: globalRepo });
    const body = await readConversationBodyForParsing(
      engine,
      pageWith('../outside/secret.txt'),
    );
    expect(body).toBe('SUMMARY body');
  });

  test('absolute path inside the owning source root is read', async () => {
    const engine = stubEngine({ sourceLocalPath: sourceRepo, repoPath: null });
    const body = await readConversationBodyForParsing(
      engine,
      pageWith(join(sourceRepo, 'transcripts', 'meeting.txt')),
    );
    expect(body).toBe('SOURCE transcript body');
  });

  test('absolute path inside sync.repo_path is read (source root set but not containing it)', async () => {
    const engine = stubEngine({ sourceLocalPath: sourceRepo, repoPath: globalRepo });
    const body = await readConversationBodyForParsing(
      engine,
      pageWith(join(globalRepo, 'transcripts', 'meeting.txt')),
    );
    expect(body).toBe('GLOBAL transcript body');
  });

  test('#3911 follow-up: absolute path OUTSIDE every registered root is rejected — summary body wins', async () => {
    const engine = stubEngine({ sourceLocalPath: sourceRepo, repoPath: globalRepo });
    const body = await readConversationBodyForParsing(
      engine,
      pageWith(join(outsideDir, 'secret.txt')),
    );
    expect(body).toBe('SUMMARY body');
    expect(body).not.toContain('OUTSIDE THE ROOT');
  });

  test('absolute path with NO registered roots is rejected (fail-closed, same as relative)', async () => {
    const engine = stubEngine({ sourceLocalPath: null, repoPath: null });
    const body = await readConversationBodyForParsing(
      engine,
      pageWith(join(sourceRepo, 'transcripts', 'meeting.txt')),
    );
    expect(body).toBe('SUMMARY body');
  });

  test('missing transcript file falls back to summary body', async () => {
    const engine = stubEngine({ sourceLocalPath: sourceRepo, repoPath: null });
    const body = await readConversationBodyForParsing(engine, pageWith('transcripts/nope.txt'));
    expect(body).toBe('SUMMARY body');
  });
});
