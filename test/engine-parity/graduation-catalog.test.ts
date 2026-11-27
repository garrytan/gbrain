/**
 * BrainEngine parity — the engine graduation inventory's catalog reads (src/core/persistence/graduation-inventory.ts
 * over engine-sql/graduation-catalog.ts on PGLite and Postgres, rust-engine/store-members/graduation-catalog.ts on Rust).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the graduation caller path reads the relation set (assertRelationSet), the foreign keys (foreignKeys)
 *    and the recorded schema version from the engine. PGLite and Postgres answer from their catalogs. The Rust store has
 *    no SQL relations: listCatalogRelations answers its keyspace list (the take kinds A 0x01..0x0A included), so
 *    assertRelationSet refuses by name (raw_sql) instead of comparing an empty set; listCatalogForeignKeys refuses by
 *    name; readCatalogSchemaVersion answers the schema version the store was opened with. That refusal is a stop by design:
 *    the case pins its exact code, capability and detail (the member and why), and that the graduation re-copy closure
 *    (fkClosure) meets the same stop, so a generic refusal or an empty list cannot replace it unnoticed.
 *  - Regression: a store with no relations reads as an empty relation set, which matches an inventory with no Rust
 *    rows, so graduation would pass its relation check on a brain it cannot copy; an empty foreign-key list reads as a
 *    store with no references.
 *  - Why existing coverage misses it: test/graduation-inventory.test.ts runs one SQL engine at a time and never the
 *    Rust arm.
 *  - Seam: the three members, through their graduation callers where one exists.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { assertRelationSet, expectedRelations, fkClosure, foreignKeys } from '../../src/core/persistence/graduation-inventory.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const { parityTest } = parityArms(testBackends());

/** The Rust store's named stop for the foreign-key list: by design, it keeps none (each family checks its references in code). */
const CATALOG_FOREIGN_KEYS_STOP = {
  code: 'engine_capability_missing', reason: 'raw_sql',
  detail: 'member=listCatalogForeignKeys (the store checks each family\'s references in code and keeps no list of them) capability=raw_sql outcome=none written=nothing',
};
const stopOf = (e: unknown) => {
  const err = e as { code?: unknown; reason?: unknown; detail?: unknown } | null;
  return { code: err?.code, reason: err?.reason, detail: err?.detail };
};

describe('engine parity: graduation catalog', () => {
  parityTest('the relation set matches the inventory; a store of keyspaces refuses the check by name', {
    methods: ['listCatalogRelations'], requires: 'raw_sql' }, async (engine) => {
    const checked = await assertRelationSet(engine, engine.kind as 'pglite' | 'postgres').then(() => null, (e: unknown) => e);
    if (checked !== null && isCapabilityRefusal(checked, 'raw_sql')) {
      // The Rust arm: the store answered its keyspace list, and the check refused instead of comparing nothing.
      const catalog = await engine.listCatalogRelations();
      expect(catalog.store).toBe('keyspaces');
      if (catalog.store !== 'keyspaces') throw checked;
      const takes = catalog.keyspaces.find(k => k.tag === 'A');
      expect({
        formatVersion: catalog.formatVersion, tags: catalog.keyspaces.length > 40,
        takeKinds: takes?.kinds.map(k => k.kind), message: String((checked as Error).message).includes('listRelations'),
      }).toEqual({ formatVersion: 8, tags: true, takeKinds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], message: true });
      throw checked;
    }
    if (checked !== null) throw checked;
    const catalog = await engine.listCatalogRelations();
    if (catalog.store !== 'sql') throw new Error(`expected SQL relations, got ${catalog.store}`);
    const names = catalog.relations.map(r => r.relation);
    return { matches: JSON.stringify(names) === JSON.stringify(expectedRelations(engine.kind as 'pglite' | 'postgres')), pages: names.includes('pages') };
  });

  parityTest('the foreign keys read from the catalog; a store that keeps no list of them refuses by name', {
    methods: ['listCatalogForeignKeys'], requires: 'raw_sql' }, async (engine) => {
    const fks = await foreignKeys(engine).catch(async (e: unknown) => {
      // A refusal must name raw_sql: the Rust engine serves 'schema', so a 'schema' refusal would contradict its capabilities.
      expect(isCapabilityRefusal(e, 'raw_sql')).toBe(true);
      // The named stop, by design (rust/docs/store/keyspaces.md): the member and why, before any work. A generic or
      // differently worded refusal, or an empty list, would hide that the store keeps no foreign-key list at all.
      expect(stopOf(e)).toEqual(CATALOG_FOREIGN_KEYS_STOP);
      // The graduation re-copy closure meets the same stop instead of a closure of the relation alone.
      expect(stopOf(await fkClosure(engine, 'sources').then(() => null, (closed: unknown) => closed))).toEqual(CATALOG_FOREIGN_KEYS_STOP);
      throw e;
    });
    expect(await engine.listCatalogForeignKeys()).toEqual([...fks]);
    const pageSource = fks.find(f => f.child === 'pages' && f.parent === 'sources');
    // Absolute, not only arm-vs-arm: two SQL arms that both answer nothing would otherwise agree.
    expect(fks.length).toBeGreaterThan(10);
    expect(pageSource?.childColumns).toEqual(['source_id']);
    return { some: fks.length > 10, pageSource: pageSource ? { childColumns: pageSource.childColumns, parentColumns: pageSource.parentColumns } : null };
  });

  parityTest('the recorded schema version is the latest migration', {
    methods: ['readCatalogSchemaVersion'] }, async (engine) => {
    const version = await engine.readCatalogSchemaVersion();
    expect(version).toBe(LATEST_VERSION);
    return version;
  });
});
