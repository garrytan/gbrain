// test/onboard-phantom-rec-gates.test.ts
//
// Regression test for phantom onboard recommendations — recs that fire on a
// coverage metric but recommend an action that structurally cannot move it,
// so they persist forever (the `onboard --check` nag that confused a
// maintenance agent: it ran the direct equivalents, they no-op'd, the recs
// stayed). See reports/onboard-auto-loop-2026-06-22 (companion to the loop fix).
//
// Two gates:
//   - extract-ner is only recommended when the active pack actually declares
//     NER inference rules (packSupportsNerInference) — the SAME predicate the
//     handler gates on, so recommender and handler can't drift.
//   - extract-timeline-from-meetings is only recommended when there is at least
//     one dated meeting page to extract FROM.
//
// HERMETICITY (this file's history): the NER gate resolves the active schema
// pack, and pack resolution is a 7-tier chain whose LAST tier is the default
// `gbrain-base`. An earlier revision of this file pinned nothing, so it read
// the operator's real `~/.gbrain/config.json` (tier 6) and passed only on
// machines that happen to pin a regex-less pack. On a clean runner the default
// `gbrain-base` applies — and gbrain-base DOES declare four inference.regex
// link_types (gbrain-base.yaml:337-350), so the rec fires and the withheld-rec
// assertion fails. Every pack-sensitive test below therefore pins
// GBRAIN_SCHEMA_PACK (tier 2, which outranks both the DB config at tier 4 and
// the home config at tier 6) inside `withEnv`, and sandboxes GBRAIN_HOME.
//
// Fixture packs:
//   - gbrain-base (bundled)         → 4 inference.regex rules → capability 'supported'
//   - no-ner-fixture-pack (written  → 0 inference.regex rules → capability 'no_rules'
//     below into a sandboxed GBRAIN_HOME's schema-packs dir)
// Both directions are asserted. The one-directional version of this test is
// exactly what let the environment dependence go unnoticed.
//
// The regex-less fixture is a synthetic user pack, NOT a bundled one: #2117
// ported the NER inference regexes into gbrain-base-v2 (this file's original
// regex-less pin), and every other bundled pack `extends` gbrain-base and
// inherits its rules through the merge — so no bundled pack is regex-less
// anymore. The pin sanity check below caught that drift exactly as designed.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';
import { checkEntityLinkCoverage, checkTimelineCoverage } from '../src/core/onboard/checks.ts';
import { packSupportsNerInference } from '../src/core/schema-pack/best-effort.ts';
import type { ResolvedPack } from '../src/core/schema-pack/registry.ts';
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
  // Cache is keyed by pack NAME, and these tests deliberately switch the
  // active pack between cases.
  _resetPackCacheForTests();
  // Defensive reset: sibling files in the same shard process
  // (test/schema-pack-sync.test.ts) stub the disk-loader via
  // __setPackLocatorForTests, and that mutation persists module-level across
  // files — a stubbed locator returns null for the bundled packs and every
  // pin below would resolve 'unresolved'.
  _resetPackLocatorForTests();
});

// Regex-less fixture pack, installed once into a dedicated sandboxed home.
// Same minimal shape as `seedPack` in test/operations-schema-pack.test.ts
// (proven to validate); `link_types: []` → packSupportsNerInference is false.
const REGEXLESS_PACK = 'no-ner-fixture-pack';
const regexlessHome = emptyHome();
{
  const dir = join(regexlessHome, '.gbrain', 'schema-packs', REGEXLESS_PACK);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), `api_version: gbrain-schema-pack-v1
name: ${REGEXLESS_PACK}
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: person
    primitive: entity
    path_prefixes:
      - people/
    aliases: []
    extractable: false
    expert_routing: false
link_types: []
frontmatter_links: []
takes_kinds:
  - fact
  - take
  - bet
  - hunch
enrichable_types: []
filing_rules: []
`, 'utf-8');
}

/** Pin the pack-resolution chain at tier 2 and sandbox the home config. */
async function withPack<T>(packName: string | undefined, fn: () => Promise<T>): Promise<T> {
  // The regex-less fixture must resolve from disk, so its pin uses the home
  // that carries it; every other pin gets a fresh empty home. Neither home
  // holds a config.json, so both stay hermetic at tier 6.
  const home = packName === REGEXLESS_PACK ? regexlessHome : emptyHome();
  return await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: packName }, fn);
}

async function seedEntities(n: number) {
  for (let i = 0; i < n; i++) {
    await engine.putPage(`person-${i}`, {
      title: `Person ${i}`,
      type: 'person' as never,
      compiled_truth: 'body that is long enough to pass any minimum-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: `people/person-${i}.md`,
    });
  }
}

// Minimal pack-shaped object for the pure predicate (only manifest.link_types read).
function fakePack(linkTypes: unknown[]): ResolvedPack {
  return { manifest: { link_types: linkTypes } } as unknown as ResolvedPack;
}

describe('packSupportsNerInference (shared recommender/handler gate)', () => {
  it('false for null/undefined', () => {
    expect(packSupportsNerInference(null)).toBe(false);
    expect(packSupportsNerInference(undefined)).toBe(false);
  });

  it('false when the pack declares no link_types', () => {
    expect(packSupportsNerInference(fakePack([]))).toBe(false);
  });

  it('false when no link_type has an inference.regex', () => {
    expect(packSupportsNerInference(fakePack([
      { verb: 'mentions' },
      { verb: 'works_at', inference: { gazetteer: true } }, // inference, but no regex
    ]))).toBe(false);
  });

  it('true when at least one link_type carries an inference.regex', () => {
    expect(packSupportsNerInference(fakePack([
      { verb: 'mentions' },
      { verb: 'cites', inference: { regex: '\\bRFC\\s?\\d+\\b' } },
    ]))).toBe(true);
  });
});

describe('checkEntityLinkCoverage — NER capability gate', () => {
  it('the regex-less fixture pack really does lack NER rules (pin sanity check)', async () => {
    // Guards the two cases below: if the fixture ever gains an
    // inference.regex rule, the withheld-rec test would start passing
    // vacuously. Assert the fixture premise directly. (This check is what
    // caught gbrain-base-v2 — the original regex-less pin — gaining NER
    // rules in #2117.)
    await withPack(REGEXLESS_PACK, async () => {
      const { loadActivePack } = await import('../src/core/schema-pack/load-active.ts');
      const { loadConfigFileOnly } = await import('../src/core/config.ts');
      const pack = await loadActivePack({ cfg: loadConfigFileOnly(), remote: false });
      expect(pack.manifest.name).toBe(REGEXLESS_PACK);
      expect(packSupportsNerInference(pack)).toBe(false);
    });
  });

  it('the regex-carrying fixture pack really does declare NER rules (pin sanity check)', async () => {
    await withPack('gbrain-base', async () => {
      const { loadActivePack } = await import('../src/core/schema-pack/load-active.ts');
      const { loadConfigFileOnly } = await import('../src/core/config.ts');
      const pack = await loadActivePack({ cfg: loadConfigFileOnly(), remote: false });
      expect(pack.manifest.name).toBe('gbrain-base');
      expect(packSupportsNerInference(pack)).toBe(true);
    });
  });

  it('low coverage + pack WITHOUT NER rules → WARN but NO extract-ner rec, with a reason', async () => {
    await seedEntities(3); // entity pages, zero inbound links → coverage 0%
    await withPack(REGEXLESS_PACK, async () => {
      const { check, remediations } = await checkEntityLinkCoverage(engine);
      expect(check.status).toBe('warn');
      expect(remediations).toHaveLength(0);
      expect(check.message).toContain('no auto-fix');
      expect(check.message).toContain('NER inference rules');
    });
  });

  it('low coverage + pack WITH NER rules → recommends extract-ner', async () => {
    // The positive direction. Without this case, "no rec emitted" passes for
    // any reason at all — including a pack that never resolved.
    await seedEntities(3);
    await withPack('gbrain-base', async () => {
      const { check, remediations } = await checkEntityLinkCoverage(engine);
      expect(check.status).toBe('warn');
      expect(remediations).toHaveLength(1);
      expect(remediations[0]?.job).toBe('extract-ner');
      expect(check.message).not.toContain('no auto-fix');
    });
  });

  it('unresolvable pack → rec withheld, but the message says so distinctly', async () => {
    // Fail-closed must stay VISIBLE. A pack that cannot be resolved is an
    // operator problem, and must not read as "your pack declares no NER rules".
    await seedEntities(3);
    await withPack('no-such-pack-e2e-fixture', async () => {
      const { check, remediations } = await checkEntityLinkCoverage(engine);
      expect(check.status).toBe('warn');
      expect(remediations).toHaveLength(0);
      expect(check.message).toContain('could not resolve the active schema pack');
      expect(check.message).not.toContain('declares no NER inference rules');
    });
  });
});

describe('recommender / handler parity (the anti-drift invariant)', () => {
  // The whole point of the fix: the thing that RECOMMENDS extract-ner and the
  // thing that RUNS it must agree, on the same brain, about whether the job
  // can do anything. Sharing only the capability predicate is not enough —
  // if the two resolve DIFFERENT packs they can still disagree, which is why
  // both now go through loadActivePackForLocalEngine. Asserted as a paired
  // invariant rather than two independent expectations, so a future change to
  // either side that breaks the pairing fails here.
  for (const [pack, expectRec] of [['gbrain-base', true], [REGEXLESS_PACK, false]] as const) {
    it(`agree on ${pack}: rec emitted=${expectRec} ⇔ handler can run`, async () => {
      await seedEntities(3);
      await withPack(pack, async () => {
        const { extractNerLinks } = await import('../src/core/extract-ner.ts');
        const { remediations } = await checkEntityLinkCoverage(engine);
        const handler = await extractNerLinks(engine, { dryRun: true });
        const recommended = remediations.some((r) => r.job === 'extract-ner');
        const handlerCanRun = handler.pack_unavailable !== true;
        expect(recommended).toBe(expectRec);
        expect(handlerCanRun).toBe(expectRec);
        expect(recommended).toBe(handlerCanRun); // the invariant itself
      });
    });
  }

  it('agree after a DB-side pack flip that the file plane cannot see', async () => {
    // The case that proves sharing the RESOLVER matters, not just the
    // predicate. Flip the pack at tier 4 (brain-wide DB config) with no env
    // var and a config-less home, so the two sides only agree if both read
    // the engine's schema_pack. With the handler on the old
    // `loadActivePackBestEffort({ engine } as never)` path this fails:
    // the recommender sees the regex-less pack and withholds, while the
    // handler resolves the tier-7 default gbrain-base and would happily run —
    // a MISSED recommendation, the phantom bug's mirror image. (The home must
    // be regexlessHome so the DB-named pack resolves from disk at all.)
    await seedEntities(3);
    await engine.setConfig('schema_pack', REGEXLESS_PACK);
    await withEnv({ GBRAIN_HOME: regexlessHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const { extractNerLinks } = await import('../src/core/extract-ner.ts');
      const { remediations } = await checkEntityLinkCoverage(engine);
      const handler = await extractNerLinks(engine, { dryRun: true });
      const recommended = remediations.some((r) => r.job === 'extract-ner');
      expect(recommended).toBe(handler.pack_unavailable !== true);
      expect(recommended).toBe(false); // the fixture declares no regex rules
    });
  });
});

describe('checkTimelineCoverage — datable-meetings gate', () => {
  // Pack-independent: this gate counts dated meeting pages, it never loads a
  // pack. Pinned anyway so the whole file is hermetic by construction.
  it('low coverage + zero dated meetings → WARN but NO rec, with a reason', async () => {
    await seedEntities(3); // entity pages with no timeline entries → coverage 0%
    await withPack('gbrain-base-v2', async () => {
      const { check, remediations } = await checkTimelineCoverage(engine);
      expect(check.status).toBe('warn');
      expect(remediations).toHaveLength(0);
      expect(check.message).toContain('no auto-fix');
      expect(check.message).toContain('dated meeting');
    });
  });

  it('low coverage + a dated meeting present → recommends extract-timeline-from-meetings', async () => {
    await seedEntities(3);
    await engine.putPage('m0', {
      title: 'Standup', type: 'meeting' as never,
      compiled_truth: 'body that is long enough to pass any minimum-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: 'meetings/m0.md',
    });
    await engine.executeRaw(
      `UPDATE pages SET effective_date = '2026-01-01' WHERE slug = $1`,
      ['m0'],
    );
    await withPack('gbrain-base-v2', async () => {
      const { check, remediations } = await checkTimelineCoverage(engine);
      expect(check.status).toBe('warn');
      expect(remediations).toHaveLength(1);
      expect(remediations[0]?.job).toBe('extract-timeline-from-meetings');
    });
  });
});
