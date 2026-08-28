/**
 * Tests for the heartbeat_max_age health-check type (#2787) and the
 * output_paths recipe frontmatter + configured-collector helper (#2788).
 * Heartbeat files live under a temp GBRAIN_HOME so nothing touches ~/.gbrain.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  parseMaxAge,
  executeHealthCheck,
  parseRecipe,
  getConfiguredCollectorOutputs,
} from '../src/commands/integrations.ts';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-hb-'));
}

function writeHeartbeat(home: string, id: string, entries: Array<{ ts: string; event: string; status: string }>): void {
  const dir = join(home, '.gbrain', 'integrations', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

describe('parseMaxAge', () => {
  test('parses h/d/m/s durations', () => {
    expect(parseMaxAge('48h')).toBe(48 * 3_600_000);
    expect(parseMaxAge('2d')).toBe(2 * 86_400_000);
    expect(parseMaxAge('90m')).toBe(90 * 60_000);
    expect(parseMaxAge('30s')).toBe(30_000);
    expect(parseMaxAge(' 48H ')).toBe(48 * 3_600_000);
  });

  test('rejects garbage', () => {
    expect(parseMaxAge('abc')).toBeNull();
    expect(parseMaxAge('48')).toBeNull();
    expect(parseMaxAge('-3h')).toBeNull();
    expect(parseMaxAge('')).toBeNull();
    expect(parseMaxAge('0h')).toBeNull();
  });
});

describe('heartbeat_max_age health check (#2787)', () => {
  test('fresh heartbeat within max_age → ok', async () => {
    const home = tempHome();
    try {
      writeHeartbeat(home, 'calendar-to-brain', [
        { ts: new Date(Date.now() - 3_600_000).toISOString(), event: 'sync', status: 'ok' },
      ]);
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const r = await executeHealthCheck(
          { type: 'heartbeat_max_age', max_age: '48h', label: 'freshness' } as any,
          'calendar-to-brain',
          true,
        );
        expect(r.status).toBe('ok');
        expect(r.output).toContain('within 48h');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('16-day-stale sense FAILS (the #2787 silent-death receipt)', async () => {
    const home = tempHome();
    try {
      writeHeartbeat(home, 'calendar-to-brain', [
        { ts: new Date(Date.now() - 16 * 86_400_000).toISOString(), event: 'sync', status: 'ok' },
      ]);
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const r = await executeHealthCheck(
          { type: 'heartbeat_max_age', max_age: '48h' } as any,
          'calendar-to-brain',
          true,
        );
        expect(r.status).toBe('fail');
        expect(r.output).toContain('exceeds max_age 48h');
        expect(r.output).toContain('stopped producing data');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('no heartbeat data at all → fail', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const r = await executeHealthCheck(
          { type: 'heartbeat_max_age', max_age: '48h' } as any,
          'never-ran',
          true,
        );
        expect(r.status).toBe('fail');
        expect(r.output).toContain('no heartbeat events');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('invalid max_age → fail with guidance, not a crash', async () => {
    const r = await executeHealthCheck(
      { type: 'heartbeat_max_age', max_age: 'soon' } as any,
      'whatever',
      true,
    );
    expect(r.status).toBe('fail');
    expect(r.output).toContain("invalid max_age 'soon'");
  });

  test('not gated on embedded trust (read-only local file)', async () => {
    const home = tempHome();
    try {
      writeHeartbeat(home, 'user-recipe', [
        { ts: new Date().toISOString(), event: 'sync', status: 'ok' },
      ]);
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const r = await executeHealthCheck(
          { type: 'heartbeat_max_age', max_age: '1d' } as any,
          'user-recipe',
          false, // NOT embedded
        );
        expect(r.status).toBe('ok');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('newest entry wins even when the file is not time-ordered', async () => {
    const home = tempHome();
    try {
      writeHeartbeat(home, 'unordered', [
        { ts: new Date(Date.now() - 60_000).toISOString(), event: 'sync', status: 'ok' },
        { ts: new Date(Date.now() - 20 * 86_400_000).toISOString(), event: 'sync', status: 'ok' },
      ]);
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const r = await executeHealthCheck(
          { type: 'heartbeat_max_age', max_age: '48h' } as any,
          'unordered',
          true,
        );
        expect(r.status).toBe('ok');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('works inside any_of', async () => {
    const home = tempHome();
    try {
      writeHeartbeat(home, 'combo', [
        { ts: new Date().toISOString(), event: 'sync', status: 'ok' },
      ]);
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const r = await executeHealthCheck(
          { type: 'any_of', checks: [{ type: 'heartbeat_max_age', max_age: '1h' }] } as any,
          'combo',
          true,
        );
        expect(r.status).toBe('ok');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('output_paths frontmatter + configured-collector outputs (#2788)', () => {
  const RECIPE = `---
id: test-collector
name: Test Collector
version: 0.1.0
description: writes files
category: sense
health_checks: []
output_paths:
  - daily/test-collector/
setup_time: 1 min
---
Body.
`;

  test('parseRecipe surfaces output_paths (and defaults to [])', () => {
    const parsed = parseRecipe(RECIPE, 'test-collector.md');
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.output_paths).toEqual(['daily/test-collector/']);
    const bare = parseRecipe('---\nid: bare\n---\nBody.', 'bare.md');
    expect(bare!.frontmatter.output_paths).toEqual([]);
  });

  test('the shipped calendar-to-brain recipe rides the native connector: no output_paths, command probe instead of heartbeat_max_age', () => {
    // v0.47 rewrote the recipe onto the native google source kind: event
    // pages land in the source's MANAGED dir (not the brain repo), so there
    // is deliberately no repo-relative output for the collision check to
    // guard, and freshness is enforced natively (`gbrain waiting` refuses on
    // stale sources) instead of via a recipe heartbeat whose id would not
    // match the connector's funnel path.
    const content = require('node:fs').readFileSync(
      join(import.meta.dir, '..', 'recipes', 'calendar-to-brain.md'),
      'utf-8',
    );
    const parsed = parseRecipe(content, 'calendar-to-brain.md');
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.output_paths).toEqual([]);
    const hb = parsed!.frontmatter.health_checks.find(
      (c: any) => typeof c === 'object' && c.type === 'heartbeat_max_age',
    );
    expect(hb).toBeUndefined();
    const probe = parsed!.frontmatter.health_checks.find(
      (c: any) => typeof c === 'object' && c.type === 'command',
    ) as any;
    expect(probe).toBeDefined();
    expect(probe.argv).toEqual(['gbrain', 'google', 'status', '--json']);
  });

  test('getConfiguredCollectorOutputs includes secretless recipes with output_paths', async () => {
    const home = tempHome();
    const recipesDir = mkdtempSync(join(tmpdir(), 'gbrain-recipes-'));
    try {
      writeFileSync(join(recipesDir, 'test-collector.md'), RECIPE);
      await withEnv({ GBRAIN_HOME: home, GBRAIN_RECIPES_DIR: recipesDir }, async () => {
        const outputs = getConfiguredCollectorOutputs();
        expect(outputs).toContainEqual({ id: 'test-collector', output_path: 'daily/test-collector/' });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(recipesDir, { recursive: true, force: true });
    }
  });
});
