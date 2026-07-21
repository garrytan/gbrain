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
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;
let priorGbrainHome: string | undefined;

beforeAll(async () => {
  // #2469: the onboard checks now read the file-plane config via
  // loadConfig(). Point GBRAIN_HOME at an empty temp dir so the host
  // machine's real ~/.gbrain/config.json (schema_pack, etc.) can't leak
  // into the default-behavior tests below.
  priorGbrainHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gbrain-onboard-home-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorGbrainHome;
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
    // Threshold-relative (v0.42.56.0): compute `declared` from the active pack
    // the same way checkTypeProliferation does, then seed declared+6 so the
    // test keeps passing when the base pack grows (e.g. #2390 added
    // event + diary and silently moved the fixed threshold).
    const { loadActivePack } = await import('../src/core/schema-pack/load-active.ts');
    const dbConfig = (await engine.getConfig('schema_pack')) ?? undefined;
    const active = await loadActivePack({ cfg: null, remote: false, dbConfig }).catch(() => null);
    const declared = active ? active.manifest.page_types.length : 15;
    const seedCount = declared + 6; // one past the warn threshold (declared+5)
    const types: string[] = [];
    for (let i = 0; i < seedCount; i++) types.push(`custom-type-${i}`);
    await seedPages(types);
    const result = await checkTypeProliferation(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toMatch(new RegExp(`${seedCount} distinct`));
  });

  it('resolves the pack from file-plane config.json schema_pack (tier 6, #2469)', async () => {
    // A pack selected via `gbrain schema use` lives ONLY in
    // ~/.gbrain/config.json. With cfg:null the check silently fell back to
    // the default pack (declared≈15) and never flagged proliferation against
    // the user's actual (smaller) pack.
    const home = mkdtempSync(join(tmpdir(), 'gbrain-onboard-'));
    const packDir = join(home, 'packs');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    mkdirSync(packDir, { recursive: true });
    const packPath = join(packDir, 'pack.yaml');
    writeFileSync(packPath, [
      'api_version: gbrain-schema-pack-v1',
      'name: tiny-file-plane',
      'version: 1.0.0',
      'description: ""',
      'gbrain_min_version: 0.38.0',
      'extends: null',
      'borrow_from: []',
      'page_types:',
      '  - name: note',
      '    primitive: entity',
      '    path_prefixes:',
      '      - notes/',
      '    aliases: []',
      '    extractable: false',
      '    expert_routing: false',
      '  - name: meeting',
      '    primitive: entity',
      '    path_prefixes:',
      '      - meetings/',
      '    aliases: []',
      '    extractable: false',
      '    expert_routing: false',
      'link_types: []',
      'frontmatter_links: []',
      'takes_kinds:',
      '  - fact',
      '  - take',
      '  - bet',
      '  - hunch',
      'enrichable_types: []',
      'filing_rules: []',
      '',
    ].join('\n'), 'utf-8');
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ schema_pack: 'tiny-file-plane' }) + '\n',
      'utf-8',
    );
    __setPackLocatorForTests((name) => (name === 'tiny-file-plane' ? packPath : null));

    // 8 distinct types: fail against tiny-file-plane (declared 2 → fail >4),
    // ok against the declared=15 fallback the old cfg:null path produced.
    await seedPages(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => `custom-${s}`));

    await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const result = await checkTypeProliferation(engine);
      expect(result.check.status).toBe('fail');
      expect(result.check.message).toContain('pack declares 2');
    });
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
