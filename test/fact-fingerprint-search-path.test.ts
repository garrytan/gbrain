/**
 * #5190 + C-NEW-1: gbrain functions pin search_path, and the fact fingerprint
 * functions (which back the withdrawal index and `forget`) return the same
 * bytes after the change. Authoring gate: (1) protects the fingerprint and
 * normalize outputs (pinned from master before the change), their behavior
 * under a hostile session search_path, every plpgsql function's pinned
 * search_path after a fresh migrate and after a pre-fix CREATE OR REPLACE,
 * withdrawal surviving the migration, and the fingerprint index plan;
 * (2) fails when a qualification changes a fingerprint (forget would stop
 * matching), when a re-applied definition drops the pin, or when a
 * same-named function in another schema can change a fingerprint; (3) the
 * static guard cannot see migration-only functions; (4) no production seam.
 * Both engines: PGLite here, PostgreSQL through
 * test/e2e/fact-fingerprint-search-path-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { FACT_WITHDRAWAL_SCHEMA_STATEMENTS } from '../src/core/facts/withdrawal-schema.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

/** [claim, gbrain_fact_fingerprint, gbrain_fact_fingerprint_v1, gbrain_fact_normalize], captured on master before #5190. */
const GOLDEN: Array<[string, string, string, string]> = [
  ["Alice works at Acme.", "5be373e2af3711a78fe9e1edfe8308e2632872351c5b76449545b96b34983244", "8574c41b1063b50e50bf46a9825e1c05cdc105817472aeaa0942141af552a9cd", "alice works at acme"],
  ["alice works at acme", "5be373e2af3711a78fe9e1edfe8308e2632872351c5b76449545b96b34983244", "5be373e2af3711a78fe9e1edfe8308e2632872351c5b76449545b96b34983244", "alice works at acme"],
  ["ALICE   WORKS\tAT\nACME!!", "5be373e2af3711a78fe9e1edfe8308e2632872351c5b76449545b96b34983244", "abc7ef3e9edae5753e201ac2e9ee2f2fea579e2ab7bfb264a2351517a2177b19", "alice works at acme"],
  ["  leading and trailing  ", "2f5342d289b88dceed4f7407da698a273299607167eb5cab5d0fdecbcceb988f", "2f5342d289b88dceed4f7407da698a273299607167eb5cab5d0fdecbcceb988f", "leading and trailing"],
  ["Uses C++ and C#, not C.", "23203ddf56b08c28850a56597ab4e6953cfbef08148de9975d2e1d2c2efc8757", "d648cb1b9efa90ad8582b3042c404d47a9c2e4ffcf5f6ceaab93413e110e3e1c", "uses c++ and c# not c"],
  ["Prefers F# over F.", "974435f8cc320c9a43c2dc5dfabd21cdb48c183b0efa80b201c96aff8f48b8fe", "bfde901403e9d756c698c36e2635d6f0b94c691f907f0dce677cd11c561505f3", "prefers f# over f"],
  ["Ships .NET 8 and Node.js 22", "9afd4c6a07f052411c99ea455fe67b45b1e2b4bb581ea0b7da5a39677fe48592", "9afd4c6a07f052411c99ea455fe67b45b1e2b4bb581ea0b7da5a39677fe48592", "ships .net 8 and node.js 22"],
  ["Version 3.5 shipped...", "d2d866ca4642acd4a96a7350d7f4f53a8fcc2a76431fb3713b530df1f2ab970e", "6b164c3028268994f4ed85d8823427f43259bd58e90209b81a2ba840f777d53a", "version 3.5 shipped"],
  ["Ends with dots...", "40365db533bc9fcea1e902b91ab9f1279d7bba0642f331f3f2cd562696c436c7", "acec85c3c0e230e1281df73d012e5e5e041b1396ae9721969a3aa73f277d18ac", "ends with dots"],
  ["Wait\u2014what? \u201cQuoted\u201d \u2018single\u2019 \u00abguillemets\u00bb \u2039one\u203a", "990f023795497691dee6d63996886231a88793235c1ae3ef75d52eab4ed344bf", "4ba761096cbf73927a742f8f2fc67a25e677dfa016652ff43240d3fa50eafa30", "wait what quoted single guillemets one"],
  ["Tabs\tand\u00a0nbsp\u2003em space", "e770628f0317a0a7f467f913421e31cf76ddc918c00e3be7d9d1a751e03bc5e2", "e770628f0317a0a7f467f913421e31cf76ddc918c00e3be7d9d1a751e03bc5e2", "tabs and\u00a0nbsp em space"],
  ["Ellipsis\u2026 and bullet \u2022 and middot \u00b7", "50135e65b2ed9e39d6d8a03271af0676157e6ee5b3d1a3ee98b3f3570369cba3", "a18b1bff0268559fd211d8f40a8c799892d670f30d1c6adc327738c742cd8af0", "ellipsis and bullet and middot"],
  ["\u00a1Hola! \u00bfQu\u00e9 tal?", "5b89c4b5de30d2978de26003351e471fe564dfb80eae74d8836fe9c833588e7f", "f02edd94e83208d1e3f2233c11c679ea5e8b9b6b94d44b85f39fa9290f53bceb", "hola qu\u00e9 tal"],
  ["\u00dcn\u00efc\u00f6d\u00e9 Stra\u00dfe \u00c6\u00d8\u00c5", "aea2836d25e1212e5eac00a19170efcf0e48e57f5954c12cbf9196ba1a3d1262", "aea2836d25e1212e5eac00a19170efcf0e48e57f5954c12cbf9196ba1a3d1262", "\u00fcn\u00efc\u00f6d\u00e9 stra\u00dfe \u00e6\u00f8\u00e5"],
  ["Mixed CASE \u0130stanbul", "a5768d42b3cc5adcae915e3a28cf4a9b14fbde3a403ee65058d61ce81b40553f", "a5768d42b3cc5adcae915e3a28cf4a9b14fbde3a403ee65058d61ce81b40553f", "mixed case istanbul"],
  ["a.b.c. d", "256bd65773afcc75192a83ec308437afbf7a9eb9acc5b635136ccf45b47d1543", "0f704e4edf108337328f234f9a8eab79759ca88f95f767fa1e5a7e0c3cf0e8c4", "a.b.c d"],
  ["trailing dot.", "80387064f838f994e83a7dd383e33b28e212482c34a12b7a5d2490a3e44ef84e", "fc884b2532eb233db7afad9c0a4ae05a9f67fe24f8af1ad10cfb5691823c2dff", "trailing dot"],
  ["x", "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881", "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881", "x"],
  ["Under_score and back\\slash", "aacd14cd1344514f73f66dd654ae574112496a7a1f43861a87d27fa837e263d5", "aed15d3a47a1416efae8a0cab6a082110374a4f36986f85b1112424e402006ca", "under score and back slash"],
  ["Apostrophe's and \"double\" quotes", "ef5570ee0426b8beb53a7a9d1f2ca1229e5434eaa88f7a52de8c061fdee2e85f", "08fbc45a1cf8305f6c34d4c546a5bda4bcdcc84f52e2a9778faacba565d052e1", "apostrophe s and double quotes"],
  ["line one\r\nline two", "e490ed577595f61675761642aa202c2f1f59ef292f58c24fe0b431b05eeb86ec", "e490ed577595f61675761642aa202c2f1f59ef292f58c24fe0b431b05eeb86ec", "line one line two"],
  ["multi   spaces    inside", "415e44a8350a382a846ed8ddf009d6f149a6a8dcd0a6c2f82d1161d7981713d9", "415e44a8350a382a846ed8ddf009d6f149a6a8dcd0a6c2f82d1161d7981713d9", "multi spaces inside"],
  ["emoji \ud83c\udf89 party", "9fd4866107fe36e30163a7c87d0a53c6724dc5bc25eaf8e98450fedf048c2b47", "9fd4866107fe36e30163a7c87d0a53c6724dc5bc25eaf8e98450fedf048c2b47", "emoji \ud83c\udf89 party"],
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", ""],
];

const PRE_FIX_TRIGGER = `CREATE OR REPLACE FUNCTION gbrain_queue_page_projection() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$`;

for (const kind of testBackends()) {
  describe(`function search_path and fact fingerprints (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    const fingerprints = (claim: string) => engine.executeRaw<{ fp: string; v1: string; norm: string }>(
      'SELECT gbrain_fact_fingerprint($1) AS fp, gbrain_fact_fingerprint_v1($1) AS v1, gbrain_fact_normalize($1) AS norm', [claim]);
    const unpinned = () => engine.executeRaw<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public' AND l.lanname = 'plpgsql' AND p.proname LIKE 'gbrain\\_%'
        AND NOT ('search_path=pg_catalog, public' = ANY(COALESCE(p.proconfig, '{}'::text[])))`);
    const searchPathMigration = MIGRATIONS.find(m => m.name.endsWith('function_search_path'))!;
    const rerunSearchPathMigration = async () => {
      expect(searchPathMigration).toBeDefined();
      await engine.setConfig('version', String(searchPathMigration.version - 1));
      await runMigrations(engine);
    };

    test('fingerprint, v1 fingerprint and normalize outputs are byte-identical to master', async () => {
      for (const [claim, fp, v1, norm] of GOLDEN) {
        const [row] = await fingerprints(claim);
        expect([claim, row!.fp, row!.v1, row!.norm]).toEqual([claim, fp, v1, norm]);
      }
    });

    test('a hostile session search_path cannot change a fingerprint', async () => {
      await engine.executeRaw('CREATE SCHEMA IF NOT EXISTS w9_hostile');
      await engine.executeRaw(`CREATE OR REPLACE FUNCTION w9_hostile.lower(text) RETURNS text LANGUAGE SQL IMMUTABLE AS $$ SELECT 'hijacked' $$`);
      await engine.executeRaw(`CREATE OR REPLACE FUNCTION w9_hostile.btrim(text) RETURNS text LANGUAGE SQL IMMUTABLE AS $$ SELECT 'hijacked' $$`);
      try {
        const rows = await engine.transaction(async tx => {
          await tx.executeRaw('SET LOCAL search_path = w9_hostile, pg_catalog, public');
          return tx.executeRaw<{ fp: string; v1: string; norm: string }>(
            'SELECT gbrain_fact_fingerprint($1) AS fp, gbrain_fact_fingerprint_v1($1) AS v1, gbrain_fact_normalize($1) AS norm', [GOLDEN[0]![0]]);
        });
        expect([rows[0]!.fp, rows[0]!.v1, rows[0]!.norm]).toEqual([GOLDEN[0]![1], GOLDEN[0]![2], GOLDEN[0]![3]]);
      } finally {
        await engine.executeRaw('DROP SCHEMA IF EXISTS w9_hostile CASCADE');
      }
    });

    test('every gbrain plpgsql function pins search_path after a fresh migrate', async () => {
      expect(await unpinned()).toEqual([]);
    });

    test('re-applied definitions keep the pin, and the migration re-pins a pre-fix definition', async () => {
      for (const statement of FACT_WITHDRAWAL_SCHEMA_STATEMENTS) await engine.executeRaw(statement);
      expect(await unpinned()).toEqual([]);
      const [queued] = await engine.executeRaw<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE proname = 'gbrain_queue_page_projection'");
      await engine.executeRaw(PRE_FIX_TRIGGER);
      expect((await unpinned()).map(r => r.sig)).toEqual(['gbrain_queue_page_projection()']);
      await rerunSearchPathMigration();
      expect(await unpinned()).toEqual([]);
      await engine.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_queue_page_projection() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$${queued!.src}$fn$`);
      expect(await unpinned()).toEqual([]);
    }, 60_000);

    test('a withdrawn fact stays withdrawn across the migration', async () => {
      const claim = 'Withdrawal example: the meeting moved to Friday.';
      const [{ fp }] = await fingerprints(claim) as Array<{ fp: string }>;
      await engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', '*', $1)`, [fp]);
      await rerunSearchPathMigration();
      await engine.executeRaw(`INSERT INTO facts (fact, source, source_id, visibility) VALUES ($1, 'w9-test', 'default', 'private')`, [claim]);
      const [row] = await engine.executeRaw<{ expired: boolean }>('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE fact = $1', [claim]);
      expect(row!.expired).toBe(true);
    }, 60_000);

    test('the fingerprint index still serves fingerprint lookups', async () => {
      const plan = await engine.transaction(async tx => {
        await tx.executeRaw('SET LOCAL enable_seqscan = off');
        return tx.executeRaw<Record<string, string>>(
          `EXPLAIN SELECT 1 FROM facts WHERE source_id = 'default' AND visibility = 'private' AND gbrain_fact_fingerprint(fact) = $1`, [GOLDEN[0]![1]]);
      });
      expect(plan.map(r => Object.values(r)[0]).join('\n')).toContain('idx_facts_withdrawal_fingerprint');
    });
  });
}
