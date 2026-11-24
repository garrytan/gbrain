/**
 * BrainEngine parity — the engine graduation inventory's catalog reads (src/core/persistence/graduation-inventory.ts
 * over engine-sql/graduation-catalog.ts on PGLite and Postgres, rust-engine/store-members/graduation-catalog.ts on Rust).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the graduation caller path reads the relation set (assertRelationSet), the foreign keys (foreignKeys)
 *    and the recorded schema version from the engine. PGLite and Postgres answer from their catalogs. The Rust store has
 *    no SQL relations: listCatalogRelations answers its keyspace list (the take kinds A 0x01..0x0A included), so
 *    assertRelationSet refuses by name (raw_sql) instead of comparing an empty set; listCatalogForeignKeys refuses by
 *    name; readCatalogSchemaVersion answers the schema version the store was opened with.
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
import { assertRelationSet, expectedRelations, foreignKeys } from '../../src/core/persistence/graduation-inventory.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const { parityTest } = parityArms(testBackends());

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
      // The store format the loaded addon writes (its newest `formatVersions` entry), never a literal.
      const storeFormat = Math.max(...((engine as unknown as { addon: { formatVersions: number[] } }).addon.formatVersions));
      expect(storeFormat).toBeGreaterThanOrEqual(8);
      expect({
        formatVersion: catalog.formatVersion, tags: catalog.keyspaces.length > 40,
        takeKinds: takes?.kinds.map(k => k.kind), message: String((checked as Error).message).includes('listRelations'),
      }).toEqual({ formatVersion: storeFormat, tags: true, takeKinds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], message: true });
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
    const fks = await foreignKeys(engine).catch((e: unknown) => {
      // A refusal must name raw_sql: the Rust engine serves 'schema', so a 'schema' refusal would contradict its capabilities.
      expect(isCapabilityRefusal(e, 'raw_sql')).toBe(true);
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
