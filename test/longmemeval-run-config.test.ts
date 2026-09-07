/**
 * run-config.ts — the pure loaders and the retrieval_config_hash's --search-pin fold.
 *
 *   - loadQuestionIds: missing file / empty file throw; comments + blanks ignored.
 *   - loadDataset: JSONL, a JSON array, a JSON non-array (refused), and a
 *     malformed line whose error names the line number.
 *   - retrievalConfigHash: an ABSENT `search_pins` hashes identically to the
 *     pre-fold shape (every existing receipt's hash is unchanged); a present
 *     map changes the hash regardless of key order.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRunConfig,
  loadDataset,
  loadQuestionIds,
  retrievalConfigHash,
  type KnobsFingerprint,
  type RetrievalPins,
  type RunConfigInput,
} from '../src/eval/longmemeval/run-config.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lme-run-config-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('loadQuestionIds', () => {
  test('missing file throws naming the flag and path', () => {
    const p = join(dir, 'nope.txt');
    expect(() => loadQuestionIds(p)).toThrow(`--question-ids file not found: ${p}`);
  });
  test('a file with only blanks and comments is empty → throws', () => {
    const p = join(dir, 'empty.txt');
    writeFileSync(p, '# dev slice\n\n   \n# another\n', 'utf8');
    expect(() => loadQuestionIds(p)).toThrow(`--question-ids file is empty: ${p}`);
  });
  test('ids are trimmed, deduped, first-seen order', () => {
    const p = join(dir, 'ids.txt');
    writeFileSync(p, '# slice\n q-2 \nq-1\nq-2\n', 'utf8');
    expect(loadQuestionIds(p)).toEqual(['q-2', 'q-1']);
  });
});

describe('loadDataset', () => {
  const q = (id: string) => ({ question_id: id, question_type: 'single-session-user', question: 'q', answer: 'a', haystack_sessions: [], answer_session_ids: [] });

  test('missing dataset throws with the download hint', () => {
    const p = join(dir, 'missing.jsonl');
    expect(() => loadDataset(p, 'https://example.invalid/dl')).toThrow(/dataset not found: .*\nDownload from https:\/\/example\.invalid\/dl/);
  });
  test('JSONL: one question per line, blank lines ignored, sha256 of the bytes', () => {
    const p = join(dir, 'd.jsonl');
    writeFileSync(p, JSON.stringify(q('a')) + '\n\n' + JSON.stringify(q('b')) + '\n', 'utf8');
    const { questions, sha256 } = loadDataset(p, 'x');
    expect(questions.map(x => x.question_id)).toEqual(['a', 'b']);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  test('a JSON array is accepted (whitespace before the bracket tolerated)', () => {
    const p = join(dir, 'd.json');
    writeFileSync(p, '  \n' + JSON.stringify([q('a'), q('b'), q('c')]), 'utf8');
    expect(loadDataset(p, 'x').questions.map(x => x.question_id)).toEqual(['a', 'b', 'c']);
  });
  test('a JSON non-array (object) is refused', () => {
    const p = join(dir, 'obj.json');
    // Starts with '[' only if it is an array; an object is parsed line-wise → line 1 error.
    writeFileSync(p, '[' + JSON.stringify(q('a')) + '\n', 'utf8'); // truncated array → JSON.parse throws
    expect(() => loadDataset(p, 'x')).toThrow();
    const p2 = join(dir, 'notarray.json');
    writeFileSync(p2, JSON.stringify({ question_id: 'a' }) + '\n{"question_id":"b"}\n', 'utf8');
    // Object lines are JSONL questions (not an array error).
    expect(loadDataset(p2, 'x').questions.map(x => x.question_id)).toEqual(['a', 'b']);
  });
  test('a malformed JSONL line names the file and the 1-based line number', () => {
    const p = join(dir, 'bad.jsonl');
    writeFileSync(p, JSON.stringify(q('a')) + '\n' + '{"question_id": "b", "broken"\n' + JSON.stringify(q('c')) + '\n', 'utf8');
    expect(() => loadDataset(p, 'x')).toThrow(`dataset ${p}:2:`);
  });
});

describe('retrievalConfigHash — --search-pin fold', () => {
  const base: RetrievalPins = {
    mode: 'balanced', keyword_only: false, reranker: { enabled: true, model: 'voyage:rerank-2.5' }, autocut: true,
    expansion: false, expansion_variant_budget: null, embedder: 'openai:text-embedding-3-large@1536', top_k: 5, trajectory: false,
  };
  const knobs: KnobsFingerprint = { knobs_hash: 'a1b2c3d4e5f60718', knobs_hash_version: 29 };

  test('no search_pins → identical to the pre-fold hash (existing receipts unchanged)', () => {
    // The pre-fold hash is the stable JSON of the eight pins + knobs; an absent
    // key must not alter it (undefined is not serialized by the harness — the
    // pins object simply lacks the key).
    const withoutKey = retrievalConfigHash(base, knobs);
    const explicitUndefined = retrievalConfigHash({ ...base, search_pins: undefined } as RetrievalPins, knobs);
    // stableStringify serializes an explicit `undefined` value as `undefined`,
    // so the harness NEVER sets the key when empty — pin that contract here.
    expect(withoutKey).toMatch(/^[0-9a-f]{64}$/);
    expect(explicitUndefined).not.toBe(withoutKey);
    expect(Object.keys(base)).not.toContain('search_pins');
  });
  test('a non-empty search_pins map changes the hash; key order does not', () => {
    const a = retrievalConfigHash({ ...base, search_pins: { 'search.adaptive_return': 'true', 'search.crag_escalation': 'off' } }, knobs);
    const b = retrievalConfigHash({ ...base, search_pins: { 'search.crag_escalation': 'off', 'search.adaptive_return': 'true' } }, knobs);
    expect(a).toBe(b);
    expect(a).not.toBe(retrievalConfigHash(base, knobs));
    expect(a).not.toBe(retrievalConfigHash({ ...base, search_pins: { 'search.adaptive_return': 'false', 'search.crag_escalation': 'off' } }, knobs));
  });
  test('buildRunConfig surfaces search_pins only when present', () => {
    const input = (pins: RetrievalPins): RunConfigInput => ({
      pins, retrieval_config_hash: 'h', dataset_sha256: 'd', dataset_questions: 1, knobs_hash: 'k', knobs_hash_version: 29,
      cache: null, reranker_skipped_rows: 0, vector_degraded_rows: 0, expansion_failed_rows: 0, expansion_replay_miss: 0,
      expansion_replay: null, gold_missing_from_haystack: 0, slug_collisions: 0, excluded_abstention: 0, question_ids_file: null, errors: 0,
    });
    expect(buildRunConfig(input(base))).not.toHaveProperty('search_pins');
    expect(buildRunConfig(input({ ...base, search_pins: { 'search.adaptive_return': 'true' } })).search_pins).toEqual({ 'search.adaptive_return': 'true' });
  });
});
