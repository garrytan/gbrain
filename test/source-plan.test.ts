import { describe, expect, test } from 'bun:test';
import { buildSourcePlanReport, classifySourceRole } from '../src/core/source-plan.ts';
import type { SourcePlanInput } from '../src/core/source-plan.ts';

const baseSource = (overrides: Partial<SourcePlanInput>): SourcePlanInput => ({
  id: 'example',
  name: 'example',
  local_path: '/tmp/example',
  last_commit: null,
  last_sync_at: new Date('2026-06-24T12:00:00.000Z'),
  config: '{}',
  created_at: new Date('2026-06-24T00:00:00.000Z'),
  page_count: 1,
  ...overrides,
});

describe('source plan role classifier', () => {
  test('maps Sawyer and Seascape repo paths to operator roles', () => {
    expect(classifySourceRole(baseSource({ id: 'gstack-code-hub', local_path: '/Users/sawbeck/Projects/seascape-hub' })).role)
      .toBe('company_knowledge');
    expect(classifySourceRole(baseSource({ id: 'site', local_path: '/Users/sawbeck/Projects/seascape-vacations-site' })).role)
      .toBe('public_site');
    expect(classifySourceRole(baseSource({ id: 'seascape-ops', local_path: '/Users/sawbeck/Projects/seascape-ops' })).role)
      .toBe('runtime_ops');
    expect(classifySourceRole(baseSource({ id: 'analytics', local_path: '/Users/sawbeck/Projects/seascape-analytics' })).role)
      .toBe('measurement');
    expect(classifySourceRole(baseSource({ id: 'sawyer-hub', local_path: '/Users/sawbeck/Projects/sawyer-hub' })).role)
      .toBe('daily_front_door');
  });

  test('maps gbrain branch/worktree paths to memory engine', () => {
    expect(classifySourceRole(baseSource({ id: 'gbrain', local_path: '/Users/sawbeck/gbrain' })).role)
      .toBe('memory_engine');
    expect(classifySourceRole(baseSource({ id: 'gbrain-full-potential', local_path: '/Users/sawbeck/gbrain-full-potential' })).role)
      .toBe('memory_engine');
  });
});

describe('source plan report', () => {
  test('summarizes host multi-source topology and gaps', () => {
    const report = buildSourcePlanReport([
      baseSource({ id: 'default', name: 'default', local_path: '/Users/sawbeck/.gstack-brain-worktree', page_count: 10 }),
      baseSource({ id: 'gstack-code-hub-ae4800f6-9c4839', local_path: '/Users/sawbeck/Projects/seascape-hub', config: '{"federated":true}', page_count: 100 }),
      baseSource({ id: 'sawyer-hub', local_path: '/Users/sawbeck/Projects/sawyer-hub', config: '{"federated":true}', page_count: 50 }),
    ]);

    expect(report.topology.shape).toBe('single_host_multi_source');
    expect(report.counts).toEqual({ sources: 3, federated: 2, isolated: 1, pages: 160 });
    expect(report.sources.map((s) => s.role)).toContain('company_knowledge');
    expect(report.sources.map((s) => s.role)).toContain('daily_front_door');
    expect(report.gaps).toContain('No runtime/ops source detected.');
    expect(report.next_actions.join('\n')).toContain('daily Needs Attention brief');
  });
});
