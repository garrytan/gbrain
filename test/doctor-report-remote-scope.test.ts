/**
 * Source isolation of the remote doctor (run_doctor): a caller whose grant
 * names one source must not read another source's id, name, slugs, counts or
 * timestamps out of any check. Each test seeds the excluded source so the
 * unscoped (local/admin) report shows the leak, then asserts the scoped report
 * does not. Shared by both engines: PGLite here, PostgreSQL through
 * test/e2e/doctor-report-remote-scope-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { doctorReportRemote, type Check, type DoctorReport } from '../src/commands/doctor.ts';
import { logSynopsisFailure } from '../src/core/audit-synopsis.ts';
import { MIGRATION_STATE_KEY, migrationSignature } from '../src/core/embedding-migration.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const MINE = 'scope-mine-src';
const OTHER = 'scope-other-src';
const OTHER_NAME = 'Other Hidden Example';
const MINE_PAGES = ['notes/mine-a', 'notes/mine-b'];
const OTHER_PAGES = ['test/other-leak-hidden', 'notes/other-leak-target', 'notes/other-leak-linker', 'notes/other-leak-take', 'notes/other-leak-filler'];
const ALL_PAGES = MINE_PAGES.length + OTHER_PAGES.length;

for (const kind of testBackends()) {
  describe(`doctorReportRemote source scope (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    let dirs: string[] = [];

    const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: undefined }, fn);
    const report = (sourceIds?: string[]) => inHome(() => doctorReportRemote(engine, { sourceIds, remote: true }));
    const check = (r: DoctorReport, name: string): Check => {
      const found = r.checks.find(c => c.name === name);
      if (!found) throw new Error(`no ${name} check`);
      return found;
    };
    const text = (c: Check) => JSON.stringify(c);

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-scope-'));
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
        close = () => engine.disconnect();
      }
      dirs = [mkdtempSync(join(tmpdir(), 'gbrain-scope-mine-')), mkdtempSync(join(tmpdir(), 'gbrain-scope-other-'))];
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, last_sync_at) VALUES
           ($1, 'Mine Example', $3, now()),
           ($2, $4, $5, now() - interval '100 hours')`,
        [MINE, OTHER, dirs[0], OTHER_NAME, dirs[1]],
      );
      for (const slug of MINE_PAGES) {
        await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: `# ${slug}\n\nbody\n` }, { sourceId: MINE });
      }
      await engine.addLink('notes/mine-a', 'notes/mine-b', 'ctx', 'mentions', 'markdown', undefined, undefined, { fromSourceId: MINE, toSourceId: MINE });
      for (const slug of OTHER_PAGES) {
        const body = slug === 'notes/other-leak-linker' ? 'See [[other-leak-target]] for details.\n' : `# ${slug}\n\nbody\n`;
        await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: body }, { sourceId: OTHER });
      }
      await engine.upsertChunks('test/other-leak-hidden', [{ chunk_index: 0, chunk_text: 'hidden body', chunk_source: 'compiled_truth' }], { sourceId: OTHER });
      await engine.executeRaw("UPDATE pages SET text_projection_revision = knowledge_revision WHERE source_id = $1 AND slug = 'test/other-leak-hidden'", [OTHER]);
    }, 120_000);

    afterAll(async () => {
      await close?.();
      for (const dir of [home, ...dirs]) rmSync(dir, { recursive: true, force: true });
    });

    test('federation_health names and grades only granted sources', async () => {
      expect(text(check(await report(), 'federation_health'))).toContain(`${OTHER}: stale`);
      const scoped = check(await report([MINE]), 'federation_health');
      expect(text(scoped)).not.toContain(OTHER);
      expect(scoped.status).toBe('ok');
      expect(scoped.message).toBe('1 source(s) healthy (parallel sync, async embed)');
    });

    test('sync_freshness never names, counts or fixes an excluded source', async () => {
      expect(text(check(await report(), 'sync_freshness'))).toContain(OTHER_NAME);
      const scoped = check(await report([MINE]), 'sync_freshness');
      expect(text(scoped)).not.toContain(OTHER);
      expect(text(scoped)).not.toContain(OTHER_NAME);
      expect(scoped.status).toBe('ok');
      expect(scoped.details).toMatchObject({ synced_recently_count: 1, stale_count: 0 });
    });

    test('sync_consolidation counts only granted sources', async () => {
      expect(check(await report(), 'sync_consolidation').message).toContain('2 active sources');
      expect(check(await report([MINE]), 'sync_consolidation').message).toBe('Single-source brain — sync --all consolidation not applicable.');
    });

    test('links_extraction_lag grades the granted source, not the brain-wide total', async () => {
      expect(check(await report(), 'links_extraction_lag').message).toContain(`(${ALL_PAGES} pages`);
      const scoped = check(await report([MINE]), 'links_extraction_lag');
      expect(scoped.details).toMatchObject({ total: MINE_PAGES.length, source_id: MINE });
      expect(scoped.message).not.toContain(`${ALL_PAGES} pages`);
    });

    test('graph_signals_coverage measures link density inside the grant', async () => {
      expect(check(await report(), 'graph_signals_coverage').message).toContain(`${(100 / ALL_PAGES).toFixed(1)}%`);
      expect(check(await report([MINE]), 'graph_signals_coverage').message).toContain('50.0% of pages have inbound links');
    });

    test('hidden_by_search_policy counts only the granted sources', async () => {
      expect(check(await report(), 'hidden_by_search_policy').message).toContain("1 under 'test/'");
      const scoped = check(await report([MINE]), 'hidden_by_search_policy');
      expect(scoped.message).toBe('No pages hidden by search-exclude policy.');
      expect(scoped.details).toMatchObject({ counts: {} });
    });

    test('link_resolution_opportunity scans only the granted sources', async () => {
      expect(check(await report(), 'link_resolution_opportunity').message).toContain('1/1 bare wikilinks');
      expect(check(await report([MINE]), 'link_resolution_opportunity').message).toBe('No bare wikilinks found');
    });

    test('contextual_retrieval_coverage counts synopsis failures of granted sources only', async () => {
      await inHome(async () => logSynopsisFailure({ pageSlug: 'notes/other-leak-filler', sourceId: OTHER, chunkIndex: 0, kind: 'timeout', pageLevelFallback: true }));
      expect(check(await report(), 'contextual_retrieval_coverage').message).toContain('1 synopsis failure(s) in last 7d');
      expect(check(await report([MINE]), 'contextual_retrieval_coverage').message).not.toContain('synopsis failure');
    });

    test("schema_pack_source_drift compares only the granted sources' overrides", async () => {
      await engine.setConfig(`schema_pack.source.${MINE}`, 'gbrain-base');
      await engine.setConfig(`schema_pack.source.${OTHER}`, 'gbrain-recommended');
      try {
        expect(check(await report(), 'schema_pack_source_drift').message).toContain('2 distinct packs across 2 sources');
        const scoped = check(await report([MINE]), 'schema_pack_source_drift');
        expect(scoped.status).toBe('ok');
        expect(scoped.message).toBe('1 per-source overrides; all point at the same pack.');
      } finally {
        await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'schema_pack.source.%'`);
      }
    });

    test('embedding_migration_state counts stale chunks of granted sources only', async () => {
      const state = { to_model: 'openai:text-embedding-3-small', to_dims: 1536, from_model: 'openai:text-embedding-3-large', from_dims: 1536, started_at: '2026-01-01T00:00:00.000Z' };
      const signature = migrationSignature(state.to_model, state.to_dims);
      const mineStale = await engine.countStaleChunks({ sourceId: MINE, signature, includeNullSignature: true });
      const wideStale = await engine.countStaleChunks({ signature, includeNullSignature: true });
      expect(wideStale).toBeGreaterThan(mineStale);
      await engine.setConfig(MIGRATION_STATE_KEY, JSON.stringify(state));
      try {
        expect(check(await report(), 'embedding_migration_state').message).toContain(`; ${wideStale} chunk(s) not yet in the target space`);
        expect(check(await report([MINE]), 'embedding_migration_state').message).toContain(`; ${mineStale} chunk(s) not yet in the target space`);
      } finally {
        await engine.executeRaw('DELETE FROM config WHERE key = $1', [MIGRATION_STATE_KEY]);
      }
    });

    describe("calibration checks read only the granted sources' profiles and takes", () => {
      beforeAll(async () => {
        const profile = `INSERT INTO calibration_profiles (source_id, holder, generated_at, total_resolved, domain_scorecards,
            pattern_statements, voice_gate_passed, voice_gate_attempts, active_bias_tags, model_id)
          VALUES ($1, $2, now() - ($3 || ' days')::interval, 9, '{}'::jsonb, ARRAY['p']::text[], $4, 1,
            ARRAY['bias-a', 'bias-b', 'bias-c']::text[], 'test-model')`;
        await engine.executeRaw(profile, [OTHER, 'self', '30', true]);
        await engine.executeRaw(profile, [OTHER, 'other-holder', '0', false]);
        const takes = await engine.executeRaw<{ id: number }>(
          `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date)
           SELECT id, 1, 'claim', 'take', 'self', 0.9, '2020-01' FROM pages WHERE source_id = $1 AND slug = 'notes/other-leak-take'
           RETURNING id`,
          [OTHER],
        );
        for (const version of ['v1', 'v2', 'v3']) {
          await engine.executeRaw(
            `INSERT INTO take_grade_cache (take_id, prompt_version, judge_model_id, evidence_signature, verdict, confidence, applied)
             VALUES ($1, $2, 'judge', 'sig', 'correct', 0.9, true)`,
            [Number(takes[0]!.id), version],
          );
        }
      });

      test('abandoned_threads', async () => {
        expect(check(await report(), 'abandoned_threads').message).toContain('1 high-conviction take(s)');
        expect(check(await report([MINE]), 'abandoned_threads').message).toBe('No abandoned high-conviction threads');
      });

      test('calibration_freshness', async () => {
        expect(check(await report(), 'calibration_freshness').message).toContain('Calibration profile is 30 days old');
        expect(check(await report([MINE]), 'calibration_freshness').message).toBe('No calibration profile yet (builds after 5+ resolved takes)');
      });

      test('grade_confidence_drift', async () => {
        expect(check(await report(), 'grade_confidence_drift').message).toContain('Only 3 auto-applied verdicts');
        expect(check(await report([MINE]), 'grade_confidence_drift').message).toContain('Only 0 auto-applied verdicts');
      });

      test('voice_gate_health', async () => {
        expect(check(await report(), 'voice_gate_health').message).toContain('Voice gate failed 1/1');
        expect(check(await report([MINE]), 'voice_gate_health').message).toBe('No calibration profile generation in the last 7 days');
      });

      test('brainstorm_health', async () => {
        expect(check(await report(), 'brainstorm_health').message).toContain('3 bias tag(s)');
        expect(check(await report([MINE]), 'brainstorm_health').message).toContain('Calibration profile not yet generated');
      });
    });

    test('the whole scoped report carries no trace of the excluded source', async () => {
      expect(JSON.stringify(await report())).toContain(OTHER);
      const scoped = JSON.stringify(await report([MINE]));
      expect(scoped).not.toContain(OTHER);
      expect(scoped).not.toContain(OTHER_NAME);
      expect(scoped).not.toContain('other-leak');
    });
  });
}
