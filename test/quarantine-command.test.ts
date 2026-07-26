import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runQuarantine } from '../src/commands/quarantine.ts';

describe('quarantine command', () => {
  test('lists quarantined pages with an optional source filter', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] | undefined;
    const engine = {
      executeRaw: async (sql: string, params?: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return [{
          slug: 'blocked-page',
          source_id: 'docs',
          title: 'Blocked page',
          reason: 'browser_challenge',
          detail: 'verification interstitial',
          assessed_at: '2026-07-25T00:00:00.000Z',
        }];
      },
    } as unknown as BrainEngine;

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.map(String).join(' '));
    try {
      await runQuarantine(engine, ['list', '--source', 'docs']);
    } finally {
      console.log = originalLog;
    }

    expect(capturedSql).toContain("frontmatter ? 'quarantine'");
    expect(capturedSql).toContain('source_id = $1');
    expect(capturedParams).toEqual(['docs']);
    expect(output.join('\n')).toContain('docs  blocked-page  browser_challenge');
  });
});
