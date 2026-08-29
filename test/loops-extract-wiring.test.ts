/**
 * loops-extract wiring — static assertions pinning the cross-file plumbing
 * around the open-loop LLM extractor:
 *
 *   1. jobs.ts registers 'loops_extract' via registerBuiltinJob AND lists it
 *      in GATEWAY_REFRESH_JOB_NAMES (the #3387 stale-gateway class: the
 *      extractor's judge is a gateway chat call, so a worker booted before
 *      `gbrain config set` must refresh before running it).
 *   2. The kill switch key 'loops.extraction_enabled' is a known config key.
 *   3. The relational vocabulary knows the two edge verbs the extractor
 *      writes ('owes_to', 'awaiting_reply_from') — both in KNOWN_LINK_TYPES
 *      and declared as link_types in the gbrain-base-v2 schema pack.
 *   4. The loops ops (open_loops / loops_close / loops_mute) exist on the
 *      contract with area 'loops', read/write scopes, and no localOnly on
 *      open_loops (approved remote posture D4-A).
 *
 * Source-text reads mirror the repo's guard-test style
 * (test/jobs-gateway-refresh-set.test.ts).
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeLoad } from 'js-yaml';

import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { KNOWN_LINK_TYPES } from '../src/core/search/relational-intent.ts';
import { operations } from '../src/core/operations.ts';

const REPO = path.join(import.meta.dir, '..');

describe('jobs.ts wiring', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'commands', 'jobs.ts'), 'utf8');

  test("GATEWAY_REFRESH_JOB_NAMES contains 'loops_extract'", () => {
    const m = src.match(/const GATEWAY_REFRESH_JOB_NAMES = new Set\(\[([\s\S]*?)\]\);/);
    expect(m).not.toBeNull();
    const body = m![1]!.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const names = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    expect(names).toContain('loops_extract');
  });

  test("'loops_extract' is registered via registerBuiltinJob, never bare worker.register", () => {
    const registered = [
      ...src.matchAll(/registerBuiltinJob\(\s*worker,\s*engine,\s*'([^']+)'/g),
    ].map((x) => x[1]!);
    expect(registered).toContain('loops_extract');
    expect(src).not.toMatch(/worker\.register\(\s*'loops_extract'/);
  });
});

describe('kill-switch config key', () => {
  test("KNOWN_CONFIG_KEYS includes 'loops.extraction_enabled'", () => {
    expect(KNOWN_CONFIG_KEYS).toContain('loops.extraction_enabled');
  });
});

describe('relational edge vocabulary', () => {
  test("KNOWN_LINK_TYPES includes 'owes_to' and 'awaiting_reply_from'", () => {
    expect(KNOWN_LINK_TYPES.has('owes_to')).toBe(true);
    expect(KNOWN_LINK_TYPES.has('awaiting_reply_from')).toBe(true);
  });

  test('gbrain-base-v2.yaml declares both verbs as link_types', () => {
    const raw = fs.readFileSync(
      path.join(REPO, 'src', 'core', 'schema-pack', 'base', 'gbrain-base-v2.yaml'),
      'utf8',
    );
    const pack = safeLoad(raw) as { link_types?: Array<{ name: string }> };
    expect(Array.isArray(pack.link_types)).toBe(true);
    const names = pack.link_types!.map((lt) => lt.name);
    expect(names).toContain('owes_to');
    expect(names).toContain('awaiting_reply_from');
  });
});

describe('loops operations contract', () => {
  const byName = new Map(operations.map((op) => [op.name, op]));

  test("open_loops / loops_close / loops_mute exist with area 'loops'", () => {
    for (const name of ['open_loops', 'loops_close', 'loops_mute']) {
      const op = byName.get(name);
      expect(op).toBeDefined();
      expect(op!.area).toBe('loops');
    }
  });

  test('open_loops is a read op and NOT localOnly (remote posture D4-A)', () => {
    const op = byName.get('open_loops')!;
    expect(op.scope).toBe('read');
    expect(op.mutating).toBeFalsy();
    expect(op.localOnly).toBeFalsy();
  });

  test('loops_close and loops_mute are mutating write ops', () => {
    for (const name of ['loops_close', 'loops_mute']) {
      const op = byName.get(name)!;
      expect(op.scope).toBe('write');
      expect(op.mutating).toBe(true);
    }
  });
});
