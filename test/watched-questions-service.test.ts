import { describe, expect, test } from 'bun:test';
import { runWatchedQuestionProbes } from '../src/core/services/watched-question-service.ts';
import type { SearchResult, WatchedQuestion, WatchedQuestionRun } from '../src/core/types.ts';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

describe('watched questions service', () => {
  test('baselines a watched question, then records changed required reads', async () => {
    let question: WatchedQuestion = {
      id: 'watch:retrieval',
      scope_id: 'workspace:default',
      question: 'What changed about retrieval?',
      requested_scope: 'work',
      enabled: true,
      latest_fingerprint: null,
      latest_required_reads: [],
      latest_probe_at: null,
      created_at: new Date('2026-07-03T00:00:00.000Z'),
      updated_at: new Date('2026-07-03T00:00:00.000Z'),
    };
    const runs: WatchedQuestionRun[] = [];
    const searchResults: SearchResult[] = [{
      slug: 'systems/retrieval',
      page_id: 1,
      title: 'Retrieval',
      type: 'system',
      chunk_text: 'Retrieval answer evidence lives in compiled truth.',
      chunk_source: 'compiled_truth',
      score: 1,
      stale: false,
    }];
    let contentHash = 'hash:v1';
    const engine = {
      listWatchedQuestions: async () => [question],
      getWatchedQuestion: async () => question,
      updateWatchedQuestionSnapshot: async (id: string, patch: Partial<WatchedQuestion>) => {
        question = { ...question, ...patch, id };
        return question;
      },
      recordWatchedQuestionRun: async (input: WatchedQuestionRun) => {
        runs.push(input);
        return input;
      },
      searchKeyword: async () => searchResults,
      getPageProjection: async () => ({ content_hash: contentHash }),
      listNoteSectionEntries: async () => [{
        scope_id: 'workspace:default',
        page_slug: 'systems/retrieval',
        page_path: 'systems/retrieval.md',
        section_id: 'systems/retrieval#compiled-truth',
        heading_path: ['Compiled Truth'],
        heading_text: 'Compiled Truth',
        line_start: 1,
        line_end: 3,
        source_refs: ['Source: User, direct message, 2026-07-03 09:00 KST'],
        content_hash: 'section:v1',
        section_text: 'Retrieval answer evidence lives in compiled truth.',
      }],
      listMemoryCandidateEntries: async () => [],
      listCanonicalHandoffEntries: async () => [],
    };

    const first = await runWatchedQuestionProbes(engine as any, {
      scope_id: 'workspace:default',
      now: '2026-07-03T01:00:00.000Z',
    });

    expect(first).toMatchObject({ probed: 1, changed: 0, initialized: 1 });
    expect(runs[0]).toMatchObject({
      question_id: 'watch:retrieval',
      changed: false,
      previous_fingerprint: null,
      current_fingerprint: expect.any(String),
    });

    contentHash = 'hash:v2';
    const second = await runWatchedQuestionProbes(engine as any, {
      scope_id: 'workspace:default',
      now: '2026-07-03T02:00:00.000Z',
    });

    expect(second).toMatchObject({ probed: 1, changed: 1, initialized: 0 });
    expect(runs[1]).toMatchObject({
      question_id: 'watch:retrieval',
      changed: true,
      previous_fingerprint: runs[0]?.current_fingerprint,
      current_fingerprint: expect.any(String),
    });
    expect(runs[1]?.previous_required_reads[0]).toMatchObject({
      slug: 'systems/retrieval',
      content_hash: 'hash:v1',
    });
    expect(runs[1]?.current_required_reads[0]).toMatchObject({
      slug: 'systems/retrieval',
      content_hash: 'hash:v2',
    });
  });

  test('upserting an edited watched question resets the old baseline snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-watched-question-reset-'));
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
      await engine.initSchema();
      await engine.upsertWatchedQuestion({
        id: 'watch:baseline-reset',
        scope_id: 'workspace:default',
        question: 'What changed about retrieval?',
        requested_scope: 'work',
      });
      await engine.updateWatchedQuestionSnapshot('watch:baseline-reset', {
        latest_fingerprint: 'fingerprint:v1',
        latest_required_reads: [{ slug: 'systems/retrieval', content_hash: 'hash:v1' }],
        latest_probe_at: new Date('2026-07-03T01:00:00.000Z'),
      });

      const updated = await engine.upsertWatchedQuestion({
        id: 'watch:baseline-reset',
        scope_id: 'workspace:default',
        question: 'What changed about page provenance?',
        requested_scope: 'work',
      });

      expect(updated.latest_fingerprint).toBeNull();
      expect(updated.latest_required_reads).toEqual([]);
      expect(updated.latest_probe_at).toBeNull();
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
