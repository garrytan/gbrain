/**
 * The shadow fingerprint probe on Postgres hosts whose lower() or [[:space:]] answers differ from PGLite's (and Rust's):
 * a glibc en_US.utf8 database, a C-ctype database and an ICU-provider database (locale en-US, skipped where the server cannot create one),
 * each its own database with that locale (src/shadow/fingerprints.ts).
 * Twin of test/shadow-fingerprint-probe.test.ts (PGLite, the reference). Needs DATABASE_URL.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the probe names the code points where the primary's lower() / [[:space:]] / word-final sigma answers differ
 *    from PGLite's, counts the stored facts holding one, and fails only when that count is above zero.
 *  - Regression: a probe over 20 claims with no differing code point passed on a glibc host, so a swap went ahead while
 *    withdrawn facts holding U+1680 or a circled letter would not match on Rust.
 *  - Why existing coverage misses it: test/e2e/shadow-follow.test.ts stores one ASCII fact.
 *  - Seam: none. Real Postgres databases and the installed SQL functions.
 */
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { probeOnPrimary, probeRecord } from '../../src/shadow/fingerprints.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { hasDatabase } from './helpers.ts';

interface Host { engine: PostgresEngine; name: string }
const hosts: Partial<Record<'en_US' | 'C' | 'icu', Host>> = {};
let admin: ReturnType<typeof postgres>;

async function createHost(locale: string): Promise<Host> {
  const name = `gbrain_test_fp_probe_${randomUUID().replace(/-/g, '')}`;
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' ${locale}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url.toString(), poolSize: 2 });
  await engine.initSchema();
  return { engine, name };
}

async function probe(host: Host) {
  const started = performance.now();
  const { sql, ...meta } = await probeOnPrimary(host.engine);
  const ms = Math.round(performance.now() - started);
  const record = probeRecord(sql, sql.map(([fingerprint, fingerprint_v1]) => ({ fingerprint, fingerprint_v1 })), meta, new Date(0));
  console.log(`[fingerprint probe] ${record.server_version} ctype=${record.ctype} provider=${record.locale_provider} ${ms} ms: ${record.differing_code_points_total} differing, `
    + `${record.corpus_mismatches} corpus rows differ, ${record.facts_with_differing_code_points} facts affected; first: ${record.differing_code_points.slice(0, 8).join(' ')}`);
  return record;
}

const addFact = (host: Host, fact: string) => host.engine.insertFact({ fact, entity_slug: null, source: 'mcp:remember' } as never, { source_id: 'default' });
const clearFacts = (host: Host) => host.engine.executeRaw('DELETE FROM facts');

(hasDatabase() ? describe : describe.skip)('fingerprint probe on Postgres hosts', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    admin = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    hosts.en_US = await createHost(`LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'`);
    hosts.C = await createHost(`LC_COLLATE 'C' LC_CTYPE 'C'`);
    // Postgres 15 and later with ICU built in; a server without it leaves this arm out.
    hosts.icu = await createHost(`LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`).catch(() => undefined);
  }, 180_000);
  afterAll(async () => {
    for (const host of Object.values(hosts)) {
      await host.engine.disconnect();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${host.name} WITH (FORCE)`);
    }
    await admin?.end();
  }, 60_000);

  describe('glibc en_US.utf8', () => {
    test('with no fact holding a differing code point the probe passes and names the code points', async () => {
      await clearFacts(hosts.en_US!);
      await addFact(hosts.en_US!, 'Bob likes C++ and .NET, v3.5.');
      const record = await probe(hosts.en_US!);
      expect(record.ctype).toBe('en_US.utf8');
      expect(record.differing_code_points_total).toBeGreaterThan(0);
      expect(record.differing_code_points).toContain('U+1680');
      expect(record.facts_with_differing_code_points).toBe(0);
      expect(record.state).toBe('pass');
    }, 60_000);

    test('a stored fact with U+1680 or a circled letter fails the probe and is counted', async () => {
      await clearFacts(hosts.en_US!);
      await addFact(hosts.en_US!, 'Alice\u1680likes tea');
      await addFact(hosts.en_US!, 'Grade \u24b6 student');
      await addFact(hosts.en_US!, 'Plain ASCII claim');
      const record = await probe(hosts.en_US!);
      expect(record.state).toBe('fail');
      expect(record.facts_with_differing_code_points).toBe(2);
    }, 60_000);
  });

  describe('glibc en_US.utf8 with purge tombstones', () => {
    test('a purge tombstone fails the probe while code points differ, because its claim text is gone', async () => {
      const host = hosts.en_US!;
      await clearFacts(host);
      await addFact(host, 'Bob likes C++ and .NET, v3.5.');
      await host.engine.executeRaw(`DELETE FROM fact_purges`);
      expect((await probe(host)).fact_purges_unverifiable).toBe(0);
      await host.engine.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash) VALUES ('default', 'world', '*', gbrain_fact_fingerprint('Alice\u1680owes Acme money'))`);
      const record = await probe(host);
      expect(record.facts_with_differing_code_points).toBe(0);
      expect(record.fact_purges_unverifiable).toBe(1);
      expect(record.state).toBe('fail');
      await host.engine.executeRaw(`DELETE FROM fact_purges`);
      expect((await probe(host)).state).toBe('pass');
    }, 60_000);
  });

  describe('C ctype', () => {
    test('with ASCII facts only the probe passes, and the record says what differs', async () => {
      await clearFacts(hosts.C!);
      await addFact(hosts.C!, 'Bob likes C++ and .NET, v3.5.');
      const record = await probe(hosts.C!);
      expect(record.ctype).toBe('C');
      // C lower() leaves every non-ASCII letter alone, so it differs from PGLite on the cased code points; none is stored.
      expect(record.differing_code_points_total).toBeGreaterThan(0);
      expect(record.differing_code_points).toContain('U+00C9');
      expect(record.facts_with_differing_code_points).toBe(0);
      expect(record.state).toBe('pass');
    }, 60_000);

    test('a stored fact with a capital E acute fails the probe', async () => {
      await clearFacts(hosts.C!);
      await addFact(hosts.C!, '\u00c9cole claim');
      const record = await probe(hosts.C!);
      expect(record.facts_with_differing_code_points).toBe(1);
      expect(record.state).toBe('fail');
    }, 60_000);
  });

  describe('ICU provider (en-US)', () => {
    test('records the provider and locale; with no fact holding a differing code point the probe passes and names them', async () => {
      if (!hosts.icu) return console.log('[fingerprint probe] no ICU database on this server; arm skipped');
      await clearFacts(hosts.icu);
      await addFact(hosts.icu, 'Bob likes C++ and .NET, v3.5.');
      const record = await probe(hosts.icu);
      expect(record.locale_provider).toBe('i');
      expect(record.locale).toBe('en-US'); // datlocale on Postgres 17, daticulocale on 16
      expect(record.differing_code_points_total).toBeGreaterThan(0);
      expect(record.facts_with_differing_code_points).toBe(0);
      expect(record.state).toBe('pass');
    }, 60_000);

    test('a stored fact holding a code point ICU treats differently fails the probe', async () => {
      if (!hosts.icu) return;
      const first = (await probe(hosts.icu)).differing_code_points[0]!;
      await clearFacts(hosts.icu);
      await addFact(hosts.icu, `Alice${String.fromCodePoint(parseInt(first.slice(2), 16))}likes tea`);
      await addFact(hosts.icu, 'Plain ASCII claim');
      const record = await probe(hosts.icu);
      expect(record.state).toBe('fail');
      expect(record.facts_with_differing_code_points).toBe(1);
    }, 60_000);
  });
});
