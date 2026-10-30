/**
 * #7192: \`gbrain search|query --explain-target <source>:<slug> --json\` puts the
 * diagnosis and its cause in stdout JSON (it used to ride only stderr), with the
 * fix rendered as a runnable command. Without --explain-target the output stays
 * a bare array.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { captureRetrievalMeta, formatResult, resetRetrievalMetaForTests } from '../../src/cli/main.ts';
import { diagnoseTrace, TargetTrace } from '../../src/core/search/explain-target.ts';
import { withExplainTargetJson } from '../../src/cli/op-notices.ts';
import type { SearchResult } from '../../src/core/types.ts';

const row = (slug: string, score: number) => ({ slug, score, page_id: 1, title: slug, type: 'note', chunk_text: 't', chunk_source: 'compiled_truth', stale: false, source_id: 'default' }) as SearchResult;

afterEach(() => resetRetrievalMetaForTests());

describe('#7192 explain_target in CLI --json', () => {
  test('a target cut by the limit: object form with the cause, per-arm ranks and a runnable retry', () => {
    const t = new TargetTrace({ slug: 'notes/x', sourceId: 'default' });
    const pool = [row('notes/a', 0.9), row('notes/b', 0.8), row('notes/x', 0.7)];
    t.observe('arm:vector', [row('notes/x', 0.7), row('notes/a', 0.9)]);
    t.observe('arm:keyword', pool);
    for (const stage of ['fused', 'deduped', 'return_pool'] as const) t.observe(stage, pool);
    t.observe('limit_slice', pool.slice(0, 2));
    const diag = diagnoseTrace(t, pool.slice(0, 2), { tool: 'search', arguments: { query: 'acme-example terms', limit: 2, expand: false, json: true } });
    captureRetrievalMeta('retrieval', { explain_target: diag });
    const out = JSON.parse(formatResult('search', pool.slice(0, 2), { json: true, explain_target: 'default:notes/x' }));
    expect(out.results.map((r: SearchResult) => r.slug)).toEqual(['notes/a', 'notes/b']);
    expect(out.explain_target).toMatchObject({ code: 'target_beyond_limit', state: 'dropped', last_rank: 3 });
    expect(out.explain_target.arms).toEqual([{ arm: 'vector', rank: 1 }, { arm: 'keyword', rank: 3 }]);
    expect(out.explain_target.why).toContain('arm ranks: vector #1, keyword #3');
    expect(out.explain_target.fix).toMatchObject({ next: 'run', argv: ['gbrain', 'search', 'acme-example terms', '--limit', '8', '--no-expand', '--json'] });
    expect(diag.fix?.mcp).toEqual({ tool: 'search', arguments: { query: 'acme-example terms', limit: 8, expand: false } });
    expect(out.explain_target.fix.command).toContain('--limit 8');
  });

  test('no arm found it: the retry is a concrete command, not a bare tell_user_to_run', () => {
    const t = new TargetTrace({ slug: 'notes/x' });
    t.observe('arm:vector', [row('notes/a', 1)]);
    const diag = diagnoseTrace(t, [], { tool: 'search', arguments: { query: 'q' } }, [{ stage: 'keyword_arm_failed', reason: 'timeout' }] as never);
    expect(diag.why).toContain('keyword_arm_failed (timeout)');
    captureRetrievalMeta('retrieval', { explain_target: diag });
    const out = JSON.parse(formatResult('search', [], { json: true, explain_target: 'notes/x' }));
    expect(out.results).toEqual([]);
    expect(out.explain_target.fix).toMatchObject({ next: 'run', argv: ['gbrain', 'query', 'q', '--expand'] });
  });

  test('with --timings the diagnosis joins the timings document instead of replacing it', () => {
    const doc = withExplainTargetJson({ explain_target: 'notes/x' }, { explain_target: { code: 'target_returned', rank: 1 } }, { results: [], timings_ms: { total: 5 } });
    expect(doc).toEqual({ results: [], timings_ms: { total: 5 }, explain_target: { code: 'target_returned', rank: 1 } });
  });

  test('without --explain-target the --json output is still a bare array', () => {
    captureRetrievalMeta('retrieval', { explain_target: { code: 'target_returned' } });
    expect(JSON.parse(formatResult('search', [row('notes/a', 1)], { json: true }))).toHaveLength(1);
  });
});
