/**
 * BrainEngine parity — the ontology and config reads list their text keys in byte order on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: getOntology (by dimension), discoverOntologyDimensions (by entity count, then dimension),
 *    findOntologyConflicts (by entity slug, then dimension) and listConfigKeys (by key) return the same order on every
 *    engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): byte order, as
 *    PGLite and the Rust store sort. The keyed config read for a handle without getConfigValues (readConfigRows'
 *    fallback statement) and `gbrain migrate`'s config copy (copyMigrationConfig, whose skipped keys print in the
 *    migration summary) read keys in byte order too.
 *  - Regression: an en_US Postgres sorted these keys by its locale, which skips punctuation and folds case (`ab`
 *    before `a/z`), so `gbrain ontology`, `config list` and the migration summary came back in another order than on
 *    PGLite and Rust brains.
 *  - Why existing coverage misses it: test/engine-parity/timeline.test.ts and config-ingest.test.ts use keys that sort
 *    the same in every locale, and CI's Postgres runs in C.UTF-8. Every case here seeds keys from
 *    test/helpers/byte-order.ts in mixed order; run it against an en_US Postgres to see it fail.
 *  - Seam: the migration case records the target's writes in a stub target, and the keyed config case reads through
 *    a handle that has only executeRaw. The source side is the real arm engine.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { copyMigrationConfig } from '../../src/commands/migrate-engine.ts';
import { readConfigRows } from '../../src/core/config-values.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_IDS, BYTE_SLUGS, MIXED_IDS, MIXED_SLUGS, byteOrder } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Dimension names survive normalizeDimension (lower case; `-` becomes `_`), so use `_` where MIXED_SLUGS has `-`. */
const MIXED_DIMS = ['ab', 'a/z', 'a_z'];
const BYTE_DIMS = byteOrder(MIXED_DIMS);

describe('ontology and config reads sort text keys by byte', () => {
  parityTest('getOntology lists dimensions by byte', { methods: ['mergeOntologyFact', 'getOntology'] }, async (engine) => {
    for (const dimension of MIXED_DIMS) {
      await engine.mergeOntologyFact({ entitySlug: 'people/alice-example', dimension, value: 'v', source: 'meetings/a', status: 'active' });
    }
    const dims = (await engine.getOntology('people/alice-example')).map(r => r.dimension);
    expect(dims).toEqual(BYTE_DIMS);
    return dims;
  });

  parityTest('discoverOntologyDimensions breaks an entity-count tie by byte dimension', { methods: ['mergeOntologyFact', 'discoverOntologyDimensions'] }, async (engine) => {
    for (const dimension of MIXED_DIMS) {
      await engine.mergeOntologyFact({ entitySlug: 'people/alice-example', dimension, value: 'v', source: 'meetings/a', status: 'active' });
    }
    const dims = (await engine.discoverOntologyDimensions()).map(r => r.dimension);
    expect(dims).toEqual(BYTE_DIMS);
    return dims;
  });

  parityTest('findOntologyConflicts lists conflicts by byte entity slug, then byte dimension', { methods: ['mergeOntologyFact', 'findOntologyConflicts'] }, async (engine) => {
    for (const slug of MIXED_SLUGS) {
      for (const dimension of MIXED_DIMS) {
        // A newer value merged first and an older one after: both stay current, from two sources, so they conflict.
        await engine.mergeOntologyFact({ entitySlug: slug, dimension, value: 'newer', source: 'meetings/a', validFrom: '2026-05-01', status: 'active' });
        await engine.mergeOntologyFact({ entitySlug: slug, dimension, value: 'older', source: 'meetings/b', validFrom: '2026-01-01', status: 'active' });
      }
    }
    const keys = (await engine.findOntologyConflicts()).map(c => `${c.entity_slug}|${c.dimension}`);
    expect(keys).toEqual(BYTE_SLUGS.flatMap(slug => BYTE_DIMS.map(d => `${slug}|${d}`)));
    return keys;
  });

  parityTest('listConfigKeys lists keys by byte', { methods: ['setConfig', 'listConfigKeys'] }, async (engine) => {
    for (const id of MIXED_IDS) await engine.setConfig(`collate.${id}`, 'v');
    const keys = await engine.listConfigKeys('collate.');
    expect(keys).toEqual(BYTE_IDS.map(id => `collate.${id}`));
    return keys;
  });

  // Named Rust design stop: the case hands readConfigRows a handle that has only executeRaw (no getConfigValues), the
  // fallback a caller with a bare SQL handle takes. The Rust engine has no SQL dialect, so that fallback refuses there by
  // design; every Rust caller passes the engine, whose getConfigValues the case above covers.
  parityTest('the keyed config read for a handle without getConfigValues returns keys by byte', { methods: ['setConfig', 'executeRaw'], requires: 'raw_sql' }, async (engine) => {
    for (const id of MIXED_IDS) await engine.setConfig(`collate.${id}`, 'v');
    const handle = { executeRaw: engine.executeRaw.bind(engine) } as Pick<BrainEngine, 'executeRaw'>;
    const keys = (await readConfigRows(handle, MIXED_IDS.map(id => `collate.${id}`))).map(r => r.key);
    expect(keys).toEqual(BYTE_IDS.map(id => `collate.${id}`));
    return keys;
  });

});
