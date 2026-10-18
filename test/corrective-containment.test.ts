import { describe, expect, mock, test } from 'bun:test';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

function context(engine: Partial<BrainEngine>, opts: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as BrainEngine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: '__all__',
    ...opts,
  };
}

const auth = (allowedSources: string[]): NonNullable<OperationContext['auth']> => ({ token: 'fixture', clientId: 'example-client', scopes: ['read'], allowedSources });

describe('stored contradiction report containment', () => {
  // D9: scoped readers re-read each side live (find-contradictions-scoped.test.ts);
  // a stored finding with no resolvable side never leaves.
  const deniedContexts: Array<[string, Partial<OperationContext>]> = [
    ['remote', { remote: true }],
    ['unset trust', { remote: undefined as unknown as boolean }],
    ['remote all-sources sentinel', { remote: true, sourceId: '__all__' }],
    ['trusted scalar source', { sourceId: 'default' }],
    ['trusted federated scope', { auth: auth(['default']) }],
    ['empty federated grant falls back to scalar', { sourceId: 'default', auth: auth([]) }],
    ['federated grant wins over trusted all-sources sentinel', { sourceId: '__all__', auth: auth(['default']) }],
  ];
  for (const [label, opts] of deniedContexts) {
    test(`${label} never receives stored report text, totals or unresolvable findings`, async () => {
      const finding = { a: { slug: 'page-a', chunk_id: null, take_id: null }, b: { slug: 'page-b', chunk_id: null, take_id: null }, severity: 'high', axis: 'SCOPED_REPORT_SECRET' };
      const load = mock(async () => [{
        run_id: 'scoped-run', ran_at: '2026-09-01T00:00:00Z', report_json: { per_query: [{ query: 'SCOPED_QUERY_SECRET', contradictions: [finding] }] },
      }]);
      const result = await operationsByName.find_contradictions.handler(context({ loadContradictionsTrend: load as never }, opts), {}) as Record<string, unknown>;
      expect(result.contradictions).toEqual([]);
      expect(result).not.toHaveProperty('total_in_run');
      expect(JSON.stringify(result)).not.toContain('SCOPED_REPORT_SECRET');
      expect(JSON.stringify(result)).not.toContain('SCOPED_QUERY_SECRET');
    });
  }

  for (const sourceId of [undefined, '__all__']) {
    test(`trusted unscoped source ${sourceId ?? '(absent)'} retains local reports`, async () => {
      const finding = { a: { slug: 'page-a' }, b: { slug: 'page-b' }, severity: 'high', axis: 'LOCAL_QUERY_DERIVED_SECRET' };
      const load = mock(async () => [{
        run_id: 'local-run', ran_at: '2026-09-01T00:00:00Z', report_json: { per_query: [{ contradictions: [finding] }] },
      }]);
      const result = await operationsByName.find_contradictions.handler(context({ loadContradictionsTrend: load as never }, { sourceId }), {});
      expect(load).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ run_id: 'local-run', contradictions: [finding], total_in_run: 1 });
    });
  }
});

describe('remote history uses strict body sanitization', () => {
  const body = renderFactsTable([
    { rowNum: 1, claim: 'WORLD_HISTORY', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    { rowNum: 2, claim: 'PRIVATE_HISTORY', kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
  ]) + `\n${TAKES_FENCE_BEGIN}\nPRIVATE_TAKE_HISTORY\n${TAKES_FENCE_END}`;
  for (const remote of [true, undefined, false]) {
    for (const takesHoldersAllowList of [undefined, [], ['world'], ['world', 'owner-example']]) {
      test(`history sanitizes when remote=${String(remote)}, holders=${JSON.stringify(takesHoldersAllowList)}, independently of page opt-out`, async () => {
        const version = { id: 1, page_id: 1, version: 1, compiled_truth: body, frontmatter: {}, snapshot_at: new Date() };
        const getVersions = mock(async () => [version]);
        const result = await operationsByName.get_versions.handler(context({
          getVersions: getVersions as never,
          // Trusted local history also reads write attribution (Foundations 1 F1b); none is recorded here.
          executeRaw: (async () => []) as never,
          // Even an operator opt-out cannot disable the Facts/Takes boundary.
          getConfig: async () => 'visible',
        }, { remote: remote as boolean, sourceId: 'default', takesHoldersAllowList }), { slug: 'example-page', include_body: true }) as Array<{ compiled_truth: string }>;
        expect(result).toHaveLength(1);
        expect(result[0].compiled_truth).toContain('WORLD_HISTORY');
        if (remote === false) {
          expect(result[0].compiled_truth).toBe(body);
        } else {
          expect(result[0].compiled_truth).not.toContain('PRIVATE_HISTORY');
          expect(result[0].compiled_truth).not.toContain('PRIVATE_TAKE_HISTORY');
        }
        expect(version.compiled_truth).toBe(body);
        expect(getVersions).toHaveBeenCalledTimes(1);
      });
    }
  }
});
