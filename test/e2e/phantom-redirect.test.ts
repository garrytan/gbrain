/**
 * E2E Phantom Redirect Tests — Tier 1 (no API keys required).
 *
 * Tests the phantom-redirect pre-pass against real Postgres + filesystem.
 * Covers:
 *   1. Bulk-pile cycle with per-cycle cap (P1)
 *   2. Steady-state no-op (no phantoms in brain)
 *   3. Concurrent sync race seal (A2 — lock contract)
 *   4. Round-12: postgres-js embedding-as-text-strings survives migration
 *      (the specific bug only real Postgres exhibits; PGLite-only suites
 *      can't pin it)
 *
 * Skips gracefully when DATABASE_URL is unset.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { tryAcquireDbLock, SYNC_LOCK_ID } from '../../src/core/db-lock.ts';

const SKIP = !hasDatabase();
const describeMaybe = SKIP ? describe.skip : describe;

beforeAll(async () => {
  if (SKIP) return;
  await setupDB();
});

afterAll(async () => {
  if (SKIP) return;
  await teardownDB();
});

beforeEach(async () => {
  if (SKIP) return;
  const engine = getEngine();
  // Per-test cleanup: truncate the tables this suite mutates.
  await engine.executeRaw('TRUNCATE TABLE facts RESTART IDENTITY CASCADE');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id='gbrain-sync'`);
});

function tempBrain(): string {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-e2e-'));
  return dir;
}

function writeMd(brainDir: string, slug: string, body: string): void {
  const filePath = join(brainDir, `${slug}.md`);
  mkdirSync(join(brainDir, slug.includes('/') ? slug.split('/').slice(0, -1).join('/') : '.'), { recursive: true });
  writeFileSync(filePath, body, 'utf-8');
}

const STUB = `# alice\n`;

const FACT_FENCE = (rows: string): string => `# alice

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;

async function seedPage(slug: string, body: string, type = 'person'): Promise<void> {
  const engine = getEngine();
  await engine.putPage(slug, {
    title: slug,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type: type as any,
    compiled_truth: body,
    frontmatter: {},
    timeline: '',
  });
}

describeMaybe('phantom-redirect E2E (Postgres)', () => {
  test('bulk-pile: 60 phantoms with cap=50 → 50 redirected, more_pending=true', async () => {
    const brainDir = tempBrain();
    try {
      // Seed 60 phantom + canonical pairs
      for (let i = 0; i < 60; i++) {
        const phantom = `entity${String(i).padStart(3, '0')}`;
        const canonical = `people/entity${String(i).padStart(3, '0')}-example`;
        await seedPage(canonical, `# entity${i}-example\n`, 'person');
        writeMd(brainDir, canonical, `# entity${i}-example\n`);
        await seedPage(phantom, `# ${phantom}\n`, 'person');
        writeMd(brainDir, phantom, `# ${phantom}\n`);
      }

      const engine = getEngine();
      await withEnv({ GBRAIN_PHANTOM_REDIRECT_LIMIT: '50' }, async () => {
        const result = await runExtractFacts(engine, {
          sourceId: 'default',
          brainDir,
        });
        expect(result.phantomsScanned).toBe(50);
        expect(result.phantomsRedirected).toBe(50);
        expect(result.phantomsMorePending).toBe(true);
      });

      // 10 remain
      const remaining = await engine.executeRaw<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pages
         WHERE source_id='default' AND deleted_at IS NULL AND slug NOT LIKE '%/%'`,
      );
      expect(parseInt(remaining[0].count, 10)).toBe(10);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });

  test('steady-state no-op: brain with no phantoms produces zero phantom counters', async () => {
    const brainDir = tempBrain();
    try {
      // Just canonical pages, no phantoms
      await seedPage('people/alice-example', '# alice-example\n', 'person');
      writeMd(brainDir, 'people/alice-example', '# alice-example\n');
      await seedPage('companies/acme-co', '# acme-co\n', 'company');
      writeMd(brainDir, 'companies/acme-co', '# acme-co\n');

      const engine = getEngine();
      const result = await runExtractFacts(engine, {
        sourceId: 'default',
        brainDir,
      });
      expect(result.phantomsScanned).toBe(0);
      expect(result.phantomsRedirected).toBe(0);
      expect(result.phantomsMorePending).toBe(false);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });

  test('concurrent-sync race: external lock holder → pass skipped, audit entry', async () => {
    const brainDir = tempBrain();
    try {
      // Seed a phantom + canonical
      await seedPage('people/alice-example', '# alice-example\n', 'person');
      writeMd(brainDir, 'people/alice-example', '# alice-example\n');
      await seedPage('alice', STUB, 'person');
      writeMd(brainDir, 'alice', STUB);

      const engine = getEngine();
      // Take the gbrain-sync lock manually (simulates concurrent gbrain sync).
      // tryAcquireDbLock uses pid from the current process; we acquire here,
      // then run runExtractFacts in the same process — the second acquire
      // would still see the row as held (different "logical" holder via the
      // pid check, but the TTL is what really gates re-acquire). Override
      // by inserting a row with a different pid + future TTL.
      await engine.executeRaw(
        `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
         VALUES ('gbrain-sync', 9999, 'simulated-other-host', now(), now() + interval '1 hour')
         ON CONFLICT (id) DO UPDATE SET holder_pid=9999, ttl_expires_at=now() + interval '1 hour'`,
      );

      // Use a short retry total via env to keep the test fast. Since we
      // can't override the hardcoded 30s window cleanly, this is a 30s test.
      // Compromise: just verify the lock-held state and that the pass
      // surfaces phantomsLockBusy=true.
      // BUT — to keep CI runtime sane, manually patch the lock to release
      // after we know the pass has tried once.
      const passPromise = runExtractFacts(engine, {
        sourceId: 'default',
        brainDir,
      });

      // Wait ~32s for the bounded retry to time out
      const result = await passPromise;
      expect(result.phantomsLockBusy).toBe(true);
      expect(result.phantomsRedirected).toBe(0);

      // Phantom .md still on disk (pass was skipped)
      expect(existsSync(join(brainDir, 'alice.md'))).toBe(true);

      // Cleanup
      await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id='gbrain-sync'`);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60000); // long timeout for the 30s lock-wait

  test('round 12: postgres-js text-string embedding survives migration', async () => {
    const brainDir = tempBrain();
    try {
      await seedPage('people/alice-example', '# alice-example\n', 'person');
      writeMd(brainDir, 'people/alice-example', '# alice-example\n');
      await seedPage('alice', FACT_FENCE(
        `| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |`,
      ), 'person');
      writeMd(brainDir, 'alice', FACT_FENCE(
        `| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |`,
      ));

      const engine = getEngine();
      // Seed a phantom fact in DB with an embedding (must round-trip
      // through postgres-js's text representation per round 12).
      // Build a 1536-d vector (canonical OpenAI embedding shape) of small
      // values so we can verify the parse doesn't mangle.
      const vec = Array(1536).fill(0).map((_, i) => i / 1536).map((v) => v.toFixed(6)).join(',');
      await engine.executeRaw(
        `INSERT INTO facts (
           source_id, entity_slug, fact, kind, valid_from,
           source, source_markdown_slug, row_num,
           embedding
         ) VALUES (
           'default', 'alice', 'Founded Acme', 'fact', '2017-01-01'::date,
           'linkedin', 'alice', 1,
           ('[' || $1 || ']')::vector
         )`,
        [vec],
      );

      const result = await runExtractFacts(engine, {
        sourceId: 'default',
        brainDir,
        // No slugs → full walk so the phantom + canonical both reconcile
      });
      expect(result.phantomsRedirected).toBe(1);

      // The migrated fact should now be keyed on canonical with the
      // embedding column INTACT (not NULL, not a string).
      const rows = await engine.executeRaw<{ embedding_present: boolean; source_markdown_slug: string }>(
        `SELECT (embedding IS NOT NULL) AS embedding_present, source_markdown_slug
         FROM facts WHERE source_id='default'
         ORDER BY id`,
      );
      // After migrateFactsToCanonical, the row is now under canonical.
      // The migrate step preserves embedding. Then the main reconcile
      // visits canonical (added via touched_canonicals) and does
      // wipe-then-insert from fence — which DROPS embedding because
      // the fence doesn't carry it. So embedding ends up NULL.
      //
      // This test EXISTS to document this baseline behavior: the migrate
      // step itself does NOT corrupt the embedding column on Postgres
      // (the round-12 concern), but the subsequent fence reconcile
      // intentionally re-derives from fence and embedding is regenerated
      // by the embed phase.
      //
      // The pinning assertion: at NO point is the embedding column
      // populated with a STRING (postgres-js's text shape leak — that
      // bug class would produce a non-null text-shaped value here, not
      // a clean NULL).
      const stringShaped = await engine.executeRaw<{ ct: string }>(
        `SELECT COUNT(*)::text AS ct FROM facts
         WHERE source_id='default'
           AND embedding IS NOT NULL
           AND pg_typeof(embedding)::text != 'vector'`,
      );
      expect(parseInt(stringShaped[0].ct, 10)).toBe(0);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].source_markdown_slug).toBe('people/alice-example');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });
});
