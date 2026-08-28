/**
 * v0.32.2 — fence-write module tests.
 *
 * Exercises the markdown-first write path: page lock + stub-create +
 * atomic .tmp + parse-validate + engine.insertFacts batch + the
 * legacy fallback for missing local_path. Real PGLite + a real
 * filesystem under a per-test tempdir.
 *
 * The page-lock contention test (multi-process integration via
 * Bun.spawn) lives in test/e2e/facts-lock-contention.test.ts (commit
 * 10's invariant E2E capstone, since spawning child processes is an
 * E2E concern). These unit/integration cases cover the in-process
 * happy + recovery paths.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeFactsToFence, lookupSourceLocalPath } from '../src/core/facts/fence-write.ts';
import type { FenceInputFact } from '../src/core/facts/fence-write.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { readRecentStubGuardEvents } from '../src/core/facts/stub-guard-audit.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Fresh tempdir per test so the fence-write FS state is hermetic.
  brainDir = mkdtempSync(join(tmpdir(), 'fence-write-test-'));
  _resetWriteThroughCacheForTest();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(`DELETE FROM config WHERE key = 'sync.write_through'`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // Default source pointed at the fresh brainDir.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

const baseInput = (overrides: Partial<FenceInputFact> = {}): FenceInputFact => ({
  fact: 'Founded Acme in 2017',
  kind: 'fact',
  notability: 'high',
  source: 'mcp:put_page',
  visibility: 'world',
  confidence: 1.0,
  validFrom: new Date(Date.UTC(2017, 0, 1)),
  embedding: null,
  sessionId: null,
  ...overrides,
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  }).trim();
}

function initGitRepo(repoPath: string): void {
  git(repoPath, 'init');
  git(repoPath, 'config', 'user.email', 't@t.t');
  git(repoPath, 'config', 'user.name', 'T');
  writeFileSync(join(repoPath, 'seed.md'), 'seed\n');
  git(repoPath, 'add', 'seed.md');
  git(repoPath, 'commit', '-m', 'init');
}

function installFakeDurabilityHook(repoPath: string): void {
  const hooksDir = join(repoPath, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'post-commit');
  writeFileSync(hookPath, [
    '#!/usr/bin/env bash',
    '# gbrain brain-durability post-commit hook (v0.42.44+)',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(hookPath, 0o755);
}

describe('writeFactsToFence — happy path', () => {
  test('stub-creates entity page when none exists, writes fence, stamps DB', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/alice', resolutionSource: 'exact_page' },
      [baseInput()],
    );

    expect(result.inserted).toBe(1);
    expect(result.ids).toHaveLength(1);
    expect(result.legacyFallback).toBeUndefined();
    expect(result.fenceWriteFailed).toBeUndefined();

    // Page was stub-created with min frontmatter.
    const filePath = join(brainDir, 'people/alice.md');
    expect(existsSync(filePath)).toBe(true);
    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain('type: person');
    expect(body).toContain('slug: people/alice');
    expect(body).toContain('## Facts');
    expect(body).toContain('Founded Acme in 2017');

    // DB row has v51 columns populated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbRows = await (engine as any).db.query(
      'SELECT row_num, source_markdown_slug, fact FROM facts WHERE id = $1',
      [result.ids[0]],
    );
    expect(dbRows.rows[0]).toMatchObject({
      row_num: 1,
      source_markdown_slug: 'people/alice',
      fact: 'Founded Acme in 2017',
    });
  });

  // #4322 regression. stubEntityPage used to pick the type from a hardcoded
  // people/companies/deals/topics ternary, so a stub under ANY other declared
  // prefix silently became `concept`. `projects/` is in the gbrain-base prefix
  // table (→ `project`) but was absent from that ternary, so it is the minimal
  // case that fails on the old code and passes on the pack-aware one. No custom
  // pack needed: with no pack configured the loader returns null and
  // inferTypeFromPack falls back to GBRAIN_BASE_PATH_PREFIXES.
  test('types a stub from the prefix table, not a hardcoded 4-entry list', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'projects/apollo', resolutionSource: 'exact_page' },
      [baseInput({ fact: 'Apollo shipped in 2017' })],
    );

    expect(result.inserted).toBe(1);
    const body = readFileSync(join(brainDir, 'projects/apollo.md'), 'utf-8');
    expect(body).toContain('type: project');
    expect(body).not.toContain('type: concept');
    expect(body).toContain('slug: projects/apollo');
  });

  test('appends to existing entity page without overwriting body', async () => {
    // Pre-create the entity page with custom content.
    const filePath = join(brainDir, 'people/bob.md');
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    writeFileSync(
      filePath,
      '---\ntype: person\ntitle: Bob\nslug: people/bob\n---\n\n# Bob\n\nMet at YC W22.\n',
      'utf-8',
    );

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/bob', resolutionSource: 'exact_page' },
      [baseInput({ fact: 'Founded Widgets Inc.' })],
    );

    expect(result.inserted).toBe(1);

    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain('Met at YC W22.'); // preserved
    expect(body).toContain('# Bob');            // preserved
    expect(body).toContain('## Facts');         // added
    expect(body).toContain('Founded Widgets Inc.');
  });

  test('multi-fact batch appends consecutive row_nums', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/carol', resolutionSource: 'exact_page' },
      [
        baseInput({ fact: 'Claim 1' }),
        baseInput({ fact: 'Claim 2' }),
        baseInput({ fact: 'Claim 3' }),
      ],
    );

    expect(result.inserted).toBe(3);
    expect(result.ids).toHaveLength(3);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT row_num, fact FROM facts WHERE source_markdown_slug = 'people/carol' ORDER BY row_num`,
    );
    expect(rows.rows.map((r: { row_num: number; fact: string }) => r.row_num)).toEqual([1, 2, 3]);
    expect(rows.rows.map((r: { fact: string }) => r.fact)).toEqual(['Claim 1', 'Claim 2', 'Claim 3']);
  });

  test('appending to a page that already has a facts fence continues row_num sequence', async () => {
    // First write seeds the fence with rows 1 and 2.
    await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/dan', resolutionSource: 'exact_page' },
      [baseInput({ fact: 'First' }), baseInput({ fact: 'Second' })],
    );

    // Second write should pick up at row_num=3.
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/dan', resolutionSource: 'exact_page' },
      [baseInput({ fact: 'Third' })],
    );

    expect(result.inserted).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT row_num, fact FROM facts WHERE source_markdown_slug = 'people/dan' ORDER BY row_num`,
    );
    expect(rows.rows[2]).toMatchObject({ row_num: 3, fact: 'Third' });
  });

  test('stub-creates nested directories (companies/x → mkdir companies)', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'companies/acme', resolutionSource: 'exact_page' },
      [baseInput({ fact: 'Founded 2017' })],
    );

    expect(result.inserted).toBe(1);
    expect(existsSync(join(brainDir, 'companies/acme.md'))).toBe(true);
    const body = readFileSync(join(brainDir, 'companies/acme.md'), 'utf-8');
    expect(body).toContain('type: company');  // type inferred from slug prefix
  });

  test('commits the fence file on a durability-hardened repo without sweeping unrelated dirt', async () => {
    initGitRepo(brainDir);
    installFakeDurabilityHook(brainDir);
    writeFileSync(join(brainDir, 'seed.md'), 'dirty unrelated edit\n');

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/durable', resolutionSource: 'exact_page' },
      [baseInput({ fact: 'Durable fence fact' })],
    );

    expect(result.inserted).toBe(1);
    expect(git(brainDir, 'log', '-1', '--format=%s')).toBe('gbrain: write-through people/durable');
    expect(git(brainDir, 'log', '-1', '--name-only', '--format=')).toBe('people/durable.md');
    expect(git(brainDir, 'status', '--porcelain', 'people/durable.md')).toBe('');
    expect(git(brainDir, 'status', '--porcelain', 'seed.md')).not.toBe('');
  }, 60_000);
});

describe('writeFactsToFence — legacy fallback', () => {
  test('null localPath returns legacyFallback:true with no inserts', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: null, slug: 'people/whoever', resolutionSource: 'exact_page' },
      [baseInput()],
    );

    expect(result).toEqual({ inserted: 0, ids: [], legacyFallback: true });

    // No DB inserts happened either.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT COUNT(*) AS n FROM facts');
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  test('empty facts array returns inserted:0 without touching FS', async () => {
    const slug = 'people/should-not-exist';
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug, resolutionSource: 'exact_page' },
      [],
    );
    expect(result).toEqual({ inserted: 0, ids: [] });
    // The page file should NOT have been stub-created since there was
    // nothing to write.
    expect(existsSync(join(brainDir, `${slug}.md`))).toBe(false);
  });
});

describe('writeFactsToFence — atomic recovery', () => {
  test('after a successful write, no .tmp file is left behind', async () => {
    await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/erin', resolutionSource: 'exact_page' },
      [baseInput()],
    );

    const tmpPath = join(brainDir, 'people/erin.md.tmp');
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe('writeFactsToFence — stub guard (v0.34.5)', () => {
  test('refuses to stub-create an unprefixed entity page (bare slug), even with exact_page provenance', async () => {
    // #4108: the guard is a UNION — the unprefixed-slug arm keeps blocking
    // regardless of resolution provenance, it wasn't replaced by the
    // provenance arm.
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'alice', resolutionSource: 'exact_page' },
      [baseInput()],
    );

    // Result shape: no facts inserted, guard flag set, no ids.
    expect(result.inserted).toBe(0);
    expect(result.ids).toHaveLength(0);
    expect(result.stubGuardBlocked).toBe(true);

    // No phantom file at brain root.
    expect(existsSync(join(brainDir, 'alice.md'))).toBe(false);
    // No phantom .tmp either.
    expect(existsSync(join(brainDir, 'alice.md.tmp'))).toBe(false);
  });

  test('prefixed slugs (people/, companies/, etc.) bypass the guard', async () => {
    // Sanity: re-prove the happy path right next to the guard test so a
    // future refactor that breaks the guard's slug.includes('/') check
    // can't silently pass by only running the guard case. #4108: passes
    // 'exact_page' — resolved-to-existing entities still fence.
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/zelda', resolutionSource: 'exact_page' },
      [baseInput({ fact: 'Founded Hyrule Labs in 2024' })],
    );

    expect(result.inserted).toBe(1);
    expect(result.stubGuardBlocked).toBeUndefined();
    expect(existsSync(join(brainDir, 'people/zelda.md'))).toBe(true);
  });

  test('empty facts array is a no-op (does NOT trigger the guard)', async () => {
    // Empty input short-circuits BEFORE the guard runs — confirming the
    // guard only fires when there's actual work the caller wants to do.
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'alice', resolutionSource: 'fallback_slugify' },
      [],
    );

    expect(result.inserted).toBe(0);
    expect(result.stubGuardBlocked).toBeUndefined();
    expect(result.legacyFallback).toBeUndefined();
    expect(existsSync(join(brainDir, 'alice.md'))).toBe(false);
  });
});

describe('writeFactsToFence — v0.46 (#3014) supersession-warning seam', () => {
  test('forwards an unresolvable `superseded by #N` warning to console.warn', async () => {
    // The reachable shape through this path: writeFactsToFence appends
    // active rows, but `context` is caller-controlled free text, so a
    // "superseded by #N" context re-parses to supersededBy=N. When #N names
    // no row, insertFacts resolves it to NULL + a warning; this test pins
    // that writeFactsToFence forwards that warning to console.warn (the
    // no-swallowed-errors seam) rather than dropping it.
    const captured: string[] = [];
    const original = console.warn;
    // eslint-disable-next-line no-console
    console.warn = (msg?: unknown) => { captured.push(String(msg)); };
    let result;
    try {
      result = await writeFactsToFence(
        engine,
        { sourceId: 'default', localPath: brainDir, slug: 'people/alice', resolutionSource: 'exact_page' },
        [baseInput({ fact: 'Points at a row that is not there', context: 'superseded by #99' })],
      );
    } finally {
      // eslint-disable-next-line no-console
      console.warn = original;
    }

    // The row still lands (the bad reference doesn't block the insert).
    expect(result.inserted).toBe(1);
    // The warning was logged with the category tag, not swallowed.
    expect(captured.some(w => w.includes('[facts.supersession]') && w.includes('absent from the fence'))).toBe(true);
  });
});

describe('writeFactsToFence — fallback-resolution stub guard (#4108)', () => {
  test('prefixed slug with fallback_slugify provenance is blocked: no page, no DB rows', async () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'stub-guard-audit-4108-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
        const result = await writeFactsToFence(
          engine,
          { sourceId: 'default', localPath: brainDir, slug: 'companies/zeta-nonexistent', resolutionSource: 'fallback_slugify' },
          [baseInput()],
        );

        expect(result.inserted).toBe(0);
        expect(result.ids).toHaveLength(0);
        expect(result.stubGuardBlocked).toBe(true);

        // No canonical stub page materialized for the invented slug.
        expect(existsSync(join(brainDir, 'companies/zeta-nonexistent.md'))).toBe(false);
        expect(existsSync(join(brainDir, 'companies/zeta-nonexistent.md.tmp'))).toBe(false);

        // No DB rows either — the CALLER routes to the legacy DB-only path.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = await (engine as any).db.query('SELECT COUNT(*) AS n FROM facts');
        expect(Number(rows.rows[0].n)).toBe(0);

        // The audit event carries the new reason so stub_guard_24h can count
        // fallback blocks separately from unprefixed ones.
        const events = readRecentStubGuardEvents({ sinceMs: 60_000 });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          slug: 'companies/zeta-nonexistent',
          reason: 'fallback_resolution',
        });
      });
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test('null provenance is blocked too (fail-closed when the caller has no resolution step)', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'companies/zeta-nullprov', resolutionSource: null },
      [baseInput()],
    );

    expect(result.stubGuardBlocked).toBe(true);
    expect(existsSync(join(brainDir, 'companies/zeta-nullprov.md'))).toBe(false);
  });

  test('fallback provenance still APPENDS when the page file already exists on disk (DB/file drift edge)', async () => {
    // The guard lives on the stub-CREATE branch only: a file that exists on
    // disk but hasn't reached the pages index yet keeps accepting appends.
    const slug = 'companies/zeta-ondisk';
    mkdirSync(join(brainDir, 'companies'), { recursive: true });
    writeFileSync(
      join(brainDir, `${slug}.md`),
      `---\ntype: company\ntitle: Zeta Ondisk\nslug: ${slug}\n---\n\n# Zeta Ondisk\n`,
      'utf-8',
    );

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug, resolutionSource: 'fallback_slugify' },
      [baseInput({ fact: 'Still accepts drift appends' })],
    );

    expect(result.inserted).toBe(1);
    expect(result.stubGuardBlocked).toBeUndefined();
    expect(readFileSync(join(brainDir, `${slug}.md`), 'utf-8')).toContain('Still accepts drift appends');
  });

  test('alias_exact provenance passes the guard (curated alias hits may stub-create)', async () => {
    // #4108 blocklist shape: only fallback_slugify/null are blocked, so the
    // v0.46.15 alias_exact member fences like exact_page/fuzzy_match.
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/star-example', resolutionSource: 'alias_exact' },
      [baseInput()],
    );

    expect(result.inserted).toBe(1);
    expect(result.stubGuardBlocked).toBeUndefined();
    expect(existsSync(join(brainDir, 'people/star-example.md'))).toBe(true);
  });
});

describe('lookupSourceLocalPath', () => {
  test('returns the configured local_path for an existing source', async () => {
    const got = await lookupSourceLocalPath(engine, 'default');
    expect(got).toBe(brainDir);
  });

  test('returns null for unknown source_id', async () => {
    const got = await lookupSourceLocalPath(engine, 'nonexistent');
    expect(got).toBeNull();
  });

  test('returns null when local_path is NULL on the source row', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const got = await lookupSourceLocalPath(engine, 'default');
    expect(got).toBeNull();
  });
});

describe('writeFactsToFence — row_num survives a fence-less rewrite', () => {
  // Regression: row_num uniqueness is enforced by idx_facts_fence_key on
  // (source_id, source_markdown_slug, row_num), but the value was derived
  // from the markdown fence alone, falling back to 1 when the file has no
  // fence. Any write path that rewrites a page without preserving its facts
  // fence (put_page write-through, sync, dream-cycle reverse-render) then
  // makes the next absorb re-issue an already-taken row_num, and the whole
  // batch dies on a duplicate-key error.
  test('does not reuse a row_num after the fence is stripped from the file', async () => {
    const slug = 'people/carol';
    const filePath = join(brainDir, `${slug}.md`);

    const first = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug, resolutionSource: 'exact_page' },
      [baseInput({ fact: 'First fact' }), baseInput({ fact: 'Second fact' })],
    );
    expect(first.inserted).toBe(2);

    // Simulate a non-fence-aware writer replacing the page body. The DB still
    // holds row_num 1 and 2; the file now advertises none.
    writeFileSync(
      filePath,
      '---\ntype: person\ntitle: Carol\nslug: people/carol\n---\n\n# Carol\n\nRegenerated without the fence.\n',
      'utf-8',
    );
    expect(readFileSync(filePath, 'utf-8')).not.toContain('First fact');

    // Pre-fix this threw: upsertFactRow restarted at 1, colliding with the
    // existing rows on idx_facts_fence_key.
    const second = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug, resolutionSource: 'exact_page' },
      [baseInput({ fact: 'Third fact' })],
    );
    expect(second.inserted).toBe(1);
    expect(second.fenceWriteFailed).toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT row_num, fact FROM facts WHERE source_markdown_slug = $1 ORDER BY row_num',
      [slug],
    );
    const rowNums = rows.rows.map((r: { row_num: number }) => r.row_num);
    // Three distinct row_nums, and the new one clears the previous maximum.
    expect(new Set(rowNums).size).toBe(3);
    expect(Math.max(...rowNums)).toBeGreaterThan(2);
  });

  test('still writes when the facts table cannot be consulted', async () => {
    // The DB seed is a hint, not a hard dependency: a lookup failure must
    // degrade to the previous file-derived behaviour rather than making
    // fence writes impossible (pre-v51 brains, transient DB errors).
    const brokenEngine = Object.create(engine) as typeof engine;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (brokenEngine as any).executeRaw = async (sqlText: string, params: unknown[]) => {
      if (sqlText.includes('MAX(row_num)')) throw new Error('simulated lookup failure');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (engine as any).executeRaw(sqlText, params);
    };

    const result = await writeFactsToFence(
      brokenEngine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/dave', resolutionSource: 'exact_page' },
      [baseInput({ fact: 'Written despite the failed hint' })],
    );
    expect(result.inserted).toBe(1);
    expect(result.fenceWriteFailed).toBeUndefined();
  });
});

describe('writeFactsToFence — sync.write_through opt-out', () => {
  test("flag 'false' suppresses the fence lane: no stub page, no fence file, legacyFallback contract", async () => {
    await engine.setConfig('sync.write_through', 'false');
    _resetWriteThroughCacheForTest();

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/alice-example', resolutionSource: 'exact_page' },
      [baseInput()],
    );

    // Same contract as a missing local_path — the caller's DB-only path
    // records the facts, so nothing is silently dropped.
    expect(result).toEqual({ inserted: 0, ids: [], legacyFallback: true });
    expect(existsSync(join(brainDir, 'people/alice-example.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'people'))).toBe(false);
    // The fence lane wrote nothing to the DB either (the caller owns the
    // DB-only insert).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT COUNT(*) AS n FROM facts');
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  test("off values parse case-insensitively ('OFF'), and no git commit fires on a hardened repo", async () => {
    initGitRepo(brainDir);
    installFakeDurabilityHook(brainDir);
    await engine.setConfig('sync.write_through', 'OFF');
    _resetWriteThroughCacheForTest();

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/db-only', resolutionSource: 'exact_page' },
      [baseInput()],
    );

    expect(result).toEqual({ inserted: 0, ids: [], legacyFallback: true });
    expect(existsSync(join(brainDir, 'people/db-only.md'))).toBe(false);
    expect(git(brainDir, 'log', '-1', '--format=%s')).toBe('init');
  }, 60_000);

  test('writeSingleFact under the flag: the DB fact still lands, no file appears', async () => {
    // No embedder configured → degraded dedup, no network (matches the
    // conformance suite's no-provider assumption).
    resetGateway();
    await engine.setConfig('sync.write_through', 'false');
    _resetWriteThroughCacheForTest();

    const r = await writeSingleFact(engine, 'default', {
      fact: 'prefers DB-only storage',
      provenance: 'test',
      entity: 'people/frank-example',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('people/frank-example');
    expect(existsSync(join(brainDir, 'people/frank-example.md'))).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT entity_slug, source_markdown_slug FROM facts WHERE id = $1',
      [r.id],
    );
    expect(rows.rows[0].entity_slug).toBe('people/frank-example');
    // No .md backs the row — the fence-tracking column stays null.
    expect(rows.rows[0].source_markdown_slug).toBeNull();
  });
});

describe('writeFactsToFence — durability latch recovery', () => {
  test('a failed commit does not latch durability off: the next write sweeps the self-dirt', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fence-latch-home-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        initGitRepo(brainDir);
        installFakeDurabilityHook(brainDir);

        // Sabotage the first commit the way real contention does: a live
        // index.lock makes git add/commit fail through all retries.
        const indexLock = join(brainDir, '.git', 'index.lock');
        writeFileSync(indexLock, '');
        const first = await writeFactsToFence(
          engine,
          { sourceId: 'default', localPath: brainDir, slug: 'people/latch', resolutionSource: 'exact_page' },
          [baseInput({ fact: 'First latch fact' })],
        );
        expect(first.inserted).toBe(1);
        // Commit failed — the fence file is uncommitted self-dirt.
        expect(git(brainDir, 'status', '--porcelain', 'people/latch.md')).not.toBe('');
        rmSync(indexLock);

        const second = await writeFactsToFence(
          engine,
          { sourceId: 'default', localPath: brainDir, slug: 'people/latch', resolutionSource: 'exact_page' },
          [baseInput({ fact: 'Second latch fact' })],
        );
        expect(second.inserted).toBe(1);
        // Pre-fix: the prewrite self-dirt recorded preexisting_dirty and
        // skipped the commit on every subsequent write, forever. The
        // path-limited commit sweeping the file's own dirt IS the recovery.
        expect(git(brainDir, 'status', '--porcelain', 'people/latch.md')).toBe('');
        expect(git(brainDir, 'log', '-1', '--format=%s')).toBe('gbrain: write-through people/latch');
        const committed = git(brainDir, 'show', 'HEAD:people/latch.md');
        expect(committed).toContain('First latch fact');
        expect(committed).toContain('Second latch fact');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("a concurrent waiter commits its write instead of skipping on the holder's in-flight dirt", async () => {
    const home = mkdtempSync(join(tmpdir(), 'fence-race-home-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        initGitRepo(brainDir);
        installFakeDurabilityHook(brainDir);
        const filePath = join(brainDir, 'people/race.md');

        // Gate writer A between its rename and its commit (insertFacts sits
        // between the two), so writer B arrives while A's content is renamed
        // into place but not yet committed — the false preexisting_dirty
        // shape from the out-of-lock prewrite snapshot.
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });
        let gated = false;
        const gatedEngine = Object.create(engine) as typeof engine;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (gatedEngine as any).insertFacts = async (rows: unknown, opts: unknown) => {
          if (!gated) { gated = true; await gate; }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (engine as any).insertFacts(rows, opts);
        };

        const a = writeFactsToFence(
          gatedEngine,
          { sourceId: 'default', localPath: brainDir, slug: 'people/race', resolutionSource: 'exact_page' },
          [baseInput({ fact: 'Writer A fact' })],
        );
        // Wait until A's rename landed (post-rename, pre-commit).
        for (let i = 0; i < 400; i++) {
          if (existsSync(filePath) && readFileSync(filePath, 'utf-8').includes('Writer A fact')) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(readFileSync(filePath, 'utf-8')).toContain('Writer A fact');

        const b = writeFactsToFence(
          engine,
          { sourceId: 'default', localPath: brainDir, slug: 'people/race', resolutionSource: 'exact_page' },
          [baseInput({ fact: 'Writer B fact' })],
        );
        // Give B a beat to start (pre-fix, its snapshot fired here, before
        // the page lock), then let A finish.
        await new Promise((r) => setTimeout(r, 100));
        release();

        const [ra, rb] = await Promise.all([a, b]);
        expect(ra.inserted).toBe(1);
        expect(rb.inserted).toBe(1);
        // B's write is committed — pre-fix B skipped its commit on A's
        // in-flight dirt and left the fence file dirty with a false audit.
        expect(git(brainDir, 'status', '--porcelain', 'people/race.md')).toBe('');
        expect(git(brainDir, 'show', 'HEAD:people/race.md')).toContain('Writer B fact');
        const failLog = join(home, '.gbrain', 'facts.write_failures.jsonl');
        if (existsSync(failLog)) {
          expect(readFileSync(failLog, 'utf-8')).not.toContain('git_durability_preexisting_dirty');
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('writeFactsToFence — path matches writePageThrough (#4204)', () => {
  test('non-default source with its own local_path fences at the tree ROOT, not .sources/<id>/', async () => {
    const projDir = mkdtempSync(join(tmpdir(), 'fence-write-proj-'));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(
        `INSERT INTO sources (id, name, local_path) VALUES ('proj', 'proj-test', $1)
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
        [projDir],
      );

      const result = await writeFactsToFence(
        engine,
        { sourceId: 'proj', localPath: projDir, slug: 'people/alice', resolutionSource: 'exact_page' },
        [baseInput()],
      );

      expect(result.inserted).toBe(1);
      // writePageThrough (#2018) writes a source that has its OWN local_path at
      // that tree's root, never nested under `.sources/` — and sync's walker
      // skips dot-directories, so a `.sources/` fence would be invisible to
      // sync and its DB rows wiped by the next extract_facts reconcile.
      expect(existsSync(join(projDir, 'people/alice.md'))).toBe(true);
      expect(existsSync(join(projDir, '.sources/proj/people/alice.md'))).toBe(false);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(`DELETE FROM facts WHERE source_id = 'proj'`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(`DELETE FROM pages WHERE source_id = 'proj'`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(`DELETE FROM sources WHERE id = 'proj'`);
    }
  });

  test("fence appends into the page's recorded source_path file, not a slug-derived twin", async () => {
    try {
      // A human-authored vault file whose on-disk name is not the slug.
      const recordedRel = 'People/Alice Smith.md';
      const recordedAbs = join(brainDir, recordedRel);
      mkdirSync(join(brainDir, 'People'), { recursive: true });
      writeFileSync(
        recordedAbs,
        '---\ntype: person\ntitle: Alice Smith\nslug: people/alice-smith\n---\n\n# Alice Smith\n',
        'utf-8',
      );
      await engine.putPage('people/alice-smith', {
        type: 'person',
        title: 'Alice Smith',
        compiled_truth: '# Alice Smith',
        source_path: recordedRel,
      }, { sourceId: 'default' });

      const result = await writeFactsToFence(
        engine,
        { sourceId: 'default', localPath: brainDir, slug: 'people/alice-smith', resolutionSource: 'exact_page' },
        [baseInput()],
      );

      expect(result.inserted).toBe(1);
      // The fence must land in the file of record (same preference
      // writePageThrough applies), or sync round-trips two divergent files.
      expect(readFileSync(recordedAbs, 'utf-8')).toContain('Founded Acme in 2017');
      expect(existsSync(join(brainDir, 'people/alice-smith.md'))).toBe(false);

      // Round-trip: forget must find the fence in the SAME file the write
      // targeted, or it degrades to a DB-only expire and leaves a live fence
      // row for the next absorb to resurrect.
      const forgot = await forgetFactInFence(engine, result.ids[0], { reason: 'test' });
      expect(forgot.ok).toBe(true);
      expect(forgot.path).toBe('fence');
      expect(readFileSync(recordedAbs, 'utf-8')).toContain('~~');
    } finally {
      // The engine is shared across the file; drop the page row so its
      // recorded source_path (relative to this test's dead tempdir) can't
      // leak into later tests.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(`DELETE FROM pages WHERE slug = 'people/alice-smith' AND source_id = 'default'`);
    }
  });

  test('unusable source tree returns targetUnresolvable so callers route to DB-only, not drop', async () => {
    // Point the source at a directory that no longer exists — the resolver
    // must refuse (same repo_not_found refusal as writePageThrough) instead
    // of blindly resurrecting the deleted tree with mkdir -p.
    const goneDir = mkdtempSync(join(tmpdir(), 'fence-write-gone-'));
    rmSync(goneDir, { recursive: true, force: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [goneDir]);

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: goneDir, slug: 'people/erin', resolutionSource: 'exact_page' },
      [baseInput()],
    );

    expect(result.inserted).toBe(0);
    expect(result.targetUnresolvable).toBe(true);
    expect(existsSync(goneDir)).toBe(false);
  });
});

// Cleanup any leftover tempdirs after the whole suite.
afterAll(() => {
  // No-op: each test cleaned up via the beforeEach; this is a safety net.
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
