// v0.42 Type Unification (T31) — 3 new onboard checks.
//
// Coverage: pack_upgrade_available fires on gbrain-base brain;
// type_proliferation pack-aware ratio (D16); dangling_aliases source-scoped
// JOIN (F12); manual_only RemediationStep flag round-trips through render.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  checkPackUpgradeAvailable,
  checkTypeProliferation,
  checkDanglingAliases,
} from '../src/core/onboard/checks.ts';
import { toOnboardRecommendation } from '../src/core/onboard/render.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  // Defensive reset: sibling test files in the same shard process
  // (test/schema-pack-sync.test.ts) call __setPackLocatorForTests to
  // stub the disk-loader. The mutation persists module-level across
  // files; without this reset, the stubbed locator returns null for
  // gbrain-base / gbrain-base-v2 and findPackSuccessors silently returns
  // []. Repros only when sync.test.ts runs first in the same shard, so
  // local single-file runs pass but CI shard 6 fails.
  _resetPackLocatorForTests();
});

async function seedPages(types: string[]) {
  for (let i = 0; i < types.length; i++) {
    await engine.putPage(`p${i}`, {
      title: `p${i}`,
      type: types[i] as never,
      compiled_truth: 'body that is long enough to pass any minimum-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: `p${i}.md`,
    });
  }
}

describe('checkPackUpgradeAvailable', () => {
  it('fires on gbrain-base brain with gbrain-base-v2 available', async () => {
    // Default active pack is gbrain-base; gbrain-base-v2 declares
    // migration_from: {pack: gbrain-base, version: "1.x"}.
    const result = await checkPackUpgradeAvailable(engine);
    expect(result.check.name).toBe('pack_upgrade_available');
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('gbrain-base-v2');
    expect(result.remediations.length).toBe(1);
    expect(result.remediations[0].job).toBe('unify-types');
    expect(result.remediations[0].protected).toBe(true);
    expect(result.remediations[0].params.target_pack).toBe('gbrain-base-v2');
  });

  it('manual_only routing via render.ts allowlist (D17)', async () => {
    const result = await checkPackUpgradeAvailable(engine);
    const step = result.remediations[0];
    const rec = toOnboardRecommendation(step);
    expect(rec.apply_policy).toBe('manual_only');
  });
});

describe('checkTypeProliferation (D16 pack-aware ratio)', () => {
  it('returns ok when distinct types under declared+5 threshold', async () => {
    await seedPages(['note', 'meeting', 'slack']);
    const result = await checkTypeProliferation(engine);
    expect(result.check.status).toBe('ok');
  });

  it('warns when distinct types exceed declared+5', async () => {
    // gbrain-base declares 24 types. warn threshold = 29.
    const types: string[] = [];
    for (let i = 0; i < 32; i++) types.push(`custom-type-${i}`);
    await seedPages(types);
    const result = await checkTypeProliferation(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toMatch(/32 distinct/);
  });
});

describe('checkDanglingAliases (F12 source-scoped JOIN)', () => {
  it('returns ok when no aliases exist', async () => {
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('ok');
  });

  it('returns ok when alias points at active canonical', async () => {
    await seedPages(['note']);  // creates p0
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old-name', 'p0')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('ok');
  });

  it('warns when alias points at missing canonical', async () => {
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old-name', 'wiki/concepts/deleted')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('1 alias rows');
  });

  it('does NOT false-positive across sources (F12 regression)', async () => {
    // Insert a canonical page in source A
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alt', 'alt') ON CONFLICT DO NOTHING`);
    await engine.putPage('shared-slug', {
      title: 'shared', type: 'note' as never,
      compiled_truth: 'body that is long enough to pass any min-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: 'shared-slug.md',
    }, { sourceId: 'alt' });
    // Insert an alias in source 'default' that points at the same slug —
    // which exists ONLY in source 'alt'. The source-scoped JOIN MUST flag
    // this as dangling (not satisfied by the alt-source canonical).
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old', 'shared-slug')`,
    );
    const result = await checkDanglingAliases(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('1 alias rows');
  });
});
