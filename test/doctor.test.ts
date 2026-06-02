import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

describe('doctor command', () => {
  test('doctor module exports runDoctor', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    expect(typeof runDoctor).toBe('function');
  });

  test('LATEST_VERSION is importable from migrate', async () => {
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    expect(typeof LATEST_VERSION).toBe('number');
  });

  test('CLI registers doctor command', async () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', '--help'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('--fast');
  });

  test('frontmatter_integrity subcheck added in v0.22.4', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/commands/doctor.ts', 'utf8');
    // Subcheck name and call into shared scanner are present.
    expect(src).toContain("name: 'frontmatter_integrity'");
    expect(src).toContain('scanBrainSources');
    // Fix hint points at the right CLI command.
    expect(src).toContain('gbrain frontmatter validate');
  });

  test('Check interface supports issues array', async () => {
    // `Check` is a TypeScript interface — type-only, no runtime value.
    // Importing it for type assertion is enough to validate the shape.
    const check: import('../src/commands/doctor.ts').Check = {
      name: 'resolver_health',
      status: 'warn',
      message: '2 issues',
      issues: [{ type: 'unreachable', skill: 'test-skill', action: 'Add trigger row' }],
    };
    expect(check.issues).toHaveLength(1);
    expect(check.issues![0].action).toContain('trigger');
  });

  test('runDoctor accepts null engine for filesystem-only mode', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    // runDoctor should accept null engine — it runs filesystem checks only.
    // Signature is (engine, args, dbSource?) — third param is optional and
    // used by --fast to distinguish "no config" from "user skipped DB check".
    // Function.length counts required params only (JS ignores ?-marked).
    expect(runDoctor.length).toBeGreaterThanOrEqual(2);
    expect(runDoctor.length).toBeLessThanOrEqual(3);
  });

  // Bug 7 — --fast should differentiate "no config anywhere" from "user
  // chose --fast with GBRAIN_DATABASE_URL / config-file URL present".
  test('getDbUrlSource reflects GBRAIN_DATABASE_URL env var', async () => {
    const { getDbUrlSource } = await import('../src/core/config.ts');
    const orig = process.env.GBRAIN_DATABASE_URL;
    const origAlt = process.env.DATABASE_URL;
    try {
      process.env.GBRAIN_DATABASE_URL = 'postgresql://test@localhost/x';
      expect(getDbUrlSource()).toBe('env:GBRAIN_DATABASE_URL');
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.DATABASE_URL = 'postgresql://test@localhost/x';
      expect(getDbUrlSource()).toBe('env:DATABASE_URL');
    } finally {
      if (orig === undefined) delete process.env.GBRAIN_DATABASE_URL;
      else process.env.GBRAIN_DATABASE_URL = orig;
      if (origAlt === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = origAlt;
    }
  });

  test('doctor --fast emits source-specific message when URL present', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // The source-aware message must reference the variable name so users
    // know where their URL is coming from.
    expect(source).toContain('Skipping DB checks (--fast mode, URL present from');
    // The null-source fallback must still mention both config + env paths.
    expect(source).toContain('GBRAIN_DATABASE_URL');
  });

  // v0.12.2 reliability wave — doctor detects JSONB double-encode + truncated
  // bodies and points users at the standalone `gbrain repair-jsonb` command.
  // Detection only; repair lives in src/commands/repair-jsonb.ts.
  test('doctor source contains jsonb_integrity and markdown_body_completeness checks', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toContain('jsonb_integrity');
    expect(source).toContain('markdown_body_completeness');
    expect(source).toContain('gbrain repair-jsonb');
  });

  test('jsonb_integrity check covers the four JSONB sites fixed in v0.12.1', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toMatch(/table:\s*'pages'.*col:\s*'frontmatter'/);
    expect(source).toMatch(/table:\s*'raw_data'.*col:\s*'data'/);
    expect(source).toMatch(/table:\s*'ingest_log'.*col:\s*'pages_updated'/);
    expect(source).toMatch(/table:\s*'files'.*col:\s*'metadata'/);
  });

  // v0.31.2 — facts_extraction_health check added in PR1 commit 12.
  // Reads ingest_log rows with source_type='facts:absorb' (written by
  // writeFactsAbsorbLog from src/core/facts/absorb-log.ts), groups by
  // (source_id, reason) over the last 24h, warns when any (source, reason)
  // pair exceeds the configurable threshold (facts.absorb_warn_threshold,
  // default 10).
  test('doctor source contains facts_extraction_health check that iterates sources', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toContain('facts_extraction_health');
    // The check must group by source_id, not hardcode 'default'.
    const block = source.slice(
      source.indexOf('// 11a-bis-2. facts_extraction_health'),
      source.indexOf('// 11a-2. effective_date_health'),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('GROUP BY source_id');
    expect(block).toContain("source_type = 'facts:absorb'");
    expect(block).toContain('facts.absorb_warn_threshold');
    // 24h window
    expect(block).toMatch(/INTERVAL\s+'24\s*hours?'/i);
    // Pre-v47 fallback (column missing) reports skipped not warn
    expect(block).toContain("Skipped (ingest_log.source_id unavailable");
    // RLS deny gives a useful message
    expect(block).toContain('RLS denies SELECT on ingest_log');
    // Negative: must NOT hardcode 'default' as the only source
    expect(block).not.toMatch(/source_id\s*=\s*'default'/);
  });

  // v0.18 RLS hardening — regression guards for PR #336 + schema backfill.
  // These are structural assertions on the source string so a silent revert
  // of the severity or the IN-filter removal fails loudly without a live DB.
  test('RLS check scans ALL public tables (no hardcoded tablename IN list near the RLS block)', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    const rlsBlock = source.slice(
      source.indexOf('// 5. RLS'),
      source.indexOf('// 6. Schema version'),
    );
    expect(rlsBlock.length).toBeGreaterThan(0);
    // Old pattern — must not come back. If it does, we're filtering the scan
    // to a hardcoded set and every plugin/user table is invisible again.
    expect(rlsBlock).not.toMatch(/tablename\s+IN\s*\(/);
    // New semantics: the scan query has no WHERE-IN filter, just schemaname='public'.
    expect(rlsBlock).toMatch(/FROM\s+pg_tables\b[\s\S]{0,200}schemaname\s*=\s*'public'/);
  });

  test('RLS check raises status=fail with quoted-identifier remediation SQL', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    const rlsBlock = source.slice(
      source.indexOf('// 5. RLS'),
      source.indexOf('// 6. Schema version'),
    );
    // Severity upgraded from 'warn' to 'fail' so `gbrain doctor` exits 1 on gaps.
    expect(rlsBlock).toMatch(/status:\s*'fail'/);
    // Remediation SQL uses quoted identifiers — safe for names with hyphens,
    // reserved words, mixed case.
    expect(rlsBlock).toContain('ALTER TABLE "public"."');
    expect(rlsBlock).toContain('ENABLE ROW LEVEL SECURITY');
  });

  test('RLS check skips on PGLite (no PostgREST, not applicable)', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    const rlsBlock = source.slice(
      source.indexOf('// 5. RLS'),
      source.indexOf('// 6. Schema version'),
    );
    expect(rlsBlock).toMatch(/engine\.kind\s*===\s*'pglite'/);
    expect(rlsBlock).toContain('PGLite');
  });

  test('RLS check reads pg_description and recognizes the GBRAIN:RLS_EXEMPT escape hatch', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    const rlsBlock = source.slice(
      source.indexOf('// 5. RLS'),
      source.indexOf('// 6. Schema version'),
    );
    expect(rlsBlock).toContain('obj_description');
    expect(rlsBlock).toContain('GBRAIN:RLS_EXEMPT');
    // The regex must require a non-empty reason= segment. "Blood" is in the
    // requirement to write a real justification, not just the prefix.
    expect(rlsBlock).toMatch(/reason=/);
  });

  // v0.26.7 — rls_event_trigger check (post-install drift detector for v35).
  // Lives AFTER `// 6. Schema version` so the existing `// 5. RLS` slice
  // tests stay intact (codex correction).
  test('rls_event_trigger check exists, scoped after schema_version, healthy on (O,A) only', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    const idx7 = source.indexOf('// 7. RLS event trigger');
    const idx8 = source.indexOf('// 8. Embedding health');
    expect(idx7).toBeGreaterThan(0);
    expect(idx8).toBeGreaterThan(idx7);
    const block = source.slice(idx7, idx8);
    expect(block).toContain("name: 'rls_event_trigger'");
    // Healthy set is origin (`O`) or always (`A`). `R` is replica-only and
    // would not fire in normal sessions; `D` is disabled. Both are warn states.
    expect(block).toMatch(/evtenabled\s*!==\s*'O'[\s\S]*?evtenabled\s*!==\s*'A'/);
    // PGLite skip path is required (no event triggers there).
    expect(block).toMatch(/engine\.kind\s*===\s*'pglite'/);
    // Recovery command names the migration version explicitly.
    expect(block).toContain('--force-retry 35');
  });

  // v0.31.7 IRON-RULE regression test for #376 + #536.
  // The graph_coverage WARN message used to suggest stale verbs (`gbrain
  // link-extract` / `gbrain timeline-extract`) that were removed in v0.16
  // when extraction was consolidated into `gbrain extract <links|timeline|all>`.
  // PR #376 (FUSED-ID) flagged the stale hint; PR #536 (mayazbay) replaced it
  // with the canonical `gbrain extract all`. Pin the user-facing copy so a
  // future edit can't silently re-regress to a stale verb.
  test('graph_coverage hint uses canonical `gbrain extract all`, not removed verbs', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/commands/doctor.ts', 'utf8');
    // Canonical form (post-v0.16 single-verb consolidation).
    expect(src).toContain('Run: gbrain extract all');
    // Stale verb names removed in v0.16 must not return.
    expect(src).not.toContain('gbrain link-extract');
    expect(src).not.toContain('gbrain timeline-extract');
  });

  // v0.32 — takes_weight_grid pure-helper export.
  // Codex review #7 demanded the check be extracted as a pure function so
  // tests target it directly with stubbed engines instead of running the
  // full runDoctor pipeline. This block validates the export shape and the
  // 4 branches (no-takes / fail / warn / ok) behaviorally against PGLite.
  test('takesWeightGridCheck is exported as a pure function', async () => {
    const mod = await import('../src/commands/doctor.ts');
    expect(typeof mod.takesWeightGridCheck).toBe('function');
  });

  test('takes_weight_grid: 0 takes → ok with "No takes yet"', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { takesWeightGridCheck } = await import('../src/commands/doctor.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      const result = await takesWeightGridCheck(engine);
      expect(result.name).toBe('takes_weight_grid');
      expect(result.status).toBe('ok');
      expect(result.message).toContain('No takes yet');
    } finally {
      await engine.disconnect();
    }
  });

  test('takes_weight_grid: 100% on-grid → ok', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { takesWeightGridCheck } = await import('../src/commands/doctor.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      // Seed a few on-grid takes via the engine's normalized path.
      await engine.putPage('test/doc-on-grid', {
        type: 'note', title: 't', compiled_truth: 'b', frontmatter: {},
      });
      const pageRows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages WHERE slug = 'test/doc-on-grid' LIMIT 1`,
      );
      await engine.addTakesBatch([
        { page_id: pageRows[0].id, row_num: 1, claim: 'a', kind: 'take', holder: 'world', weight: 0.75 },
        { page_id: pageRows[0].id, row_num: 2, claim: 'b', kind: 'take', holder: 'world', weight: 0.5 },
        { page_id: pageRows[0].id, row_num: 3, claim: 'c', kind: 'take', holder: 'world', weight: 1.0 },
      ]);
      const result = await takesWeightGridCheck(engine);
      expect(result.status).toBe('ok');
      expect(result.message).toContain('on grid');
    } finally {
      await engine.disconnect();
    }
  });

  test('takes_weight_grid: >10% off-grid → fail with fix hint', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { takesWeightGridCheck } = await import('../src/commands/doctor.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      await engine.putPage('test/doc-fail', {
        type: 'note', title: 't', compiled_truth: 'b', frontmatter: {},
      });
      const pageRows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages WHERE slug = 'test/doc-fail' LIMIT 1`,
      );
      // Bypass engine normalization: write off-grid weights directly.
      // 8 of 10 off-grid → 80%, well past the 10% fail threshold.
      for (let i = 1; i <= 8; i++) {
        await engine.executeRaw(
          `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active)
           VALUES ($1, $2, 'c', 'take', 'world', $3::real, true)`,
          [pageRows[0].id, i, 0.74],
        );
      }
      for (let i = 9; i <= 10; i++) {
        await engine.executeRaw(
          `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active)
           VALUES ($1, $2, 'c', 'take', 'world', 0.5::real, true)`,
          [pageRows[0].id, i],
        );
      }
      const result = await takesWeightGridCheck(engine);
      expect(result.status).toBe('fail');
      expect(result.message).toMatch(/8\/10/);
      expect(result.message).toContain('apply-migrations');
    } finally {
      await engine.disconnect();
    }
  });

  test('takes_weight_grid: 1-10% off-grid → warn', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { takesWeightGridCheck } = await import('../src/commands/doctor.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      await engine.putPage('test/doc-warn', {
        type: 'note', title: 't', compiled_truth: 'b', frontmatter: {},
      });
      const pageRows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages WHERE slug = 'test/doc-warn' LIMIT 1`,
      );
      // 5 off-grid out of 100 = 5% → warn band.
      for (let i = 1; i <= 5; i++) {
        await engine.executeRaw(
          `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active)
           VALUES ($1, $2, 'c', 'take', 'world', 0.74::real, true)`,
          [pageRows[0].id, i],
        );
      }
      for (let i = 6; i <= 100; i++) {
        await engine.executeRaw(
          `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active)
           VALUES ($1, $2, 'c', 'take', 'world', 0.5::real, true)`,
          [pageRows[0].id, i],
        );
      }
      const result = await takesWeightGridCheck(engine);
      expect(result.status).toBe('warn');
      expect(result.message).toMatch(/5\/100/);
    } finally {
      await engine.disconnect();
    }
  });

  test('takes_weight_grid: takes table missing → warn (graceful)', async () => {
    const { takesWeightGridCheck } = await import('../src/commands/doctor.ts');
    // Stub engine: executeRaw throws like a "relation does not exist" error.
    const stubEngine = {
      executeRaw: async () => {
        throw new Error('relation "takes" does not exist');
      },
    } as any;
    const result = await takesWeightGridCheck(stubEngine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Could not check takes weight grid');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v0.31.8 D19 — wedge migration force-retry hint.
//
// The pre-v0.31.8 minions_migration check emitted a generic
// `gbrain apply-migrations --yes` hint regardless of how partial the
// migration was. Operators wedged on v0.29.1 (3 consecutive partials)
// needed `--force-retry <v>` first because the apply-migrations runner's
// 3-consecutive-partials guard rejected plain --yes. The v0.31.8 fix
// extends the existing block in place: detect the wedge condition,
// emit the force-retry hint when matched, fall back to the plain --yes
// hint when the partial count is < 3.
// ─────────────────────────────────────────────────────────────────────────
describe('v0.31.8 — wedge migration force-retry hint (D19)', () => {
  test('local doctor source contains wedge detection alongside the existing stuck path', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // The existing forward-progress override stays intact. Both branches
    // must be present and live next to each other; replacing the override
    // with statusForVersion() would re-open stale wedge alerts (codex OV11).
    expect(source).toContain('Forward-progress override');
    expect(source).toContain('partialCount >= 3');
    // Both branches must coexist. Wedged path builds the command list with
    // --force-retry; partial path falls back to plain --yes. Order varies
    // between the local + remote doctor blocks, so just assert presence.
    expect(source).toContain('WEDGED MIGRATION(s)');
    expect(source).toContain('MINIONS HALF-INSTALLED');
    expect(source).toContain('--force-retry');
    expect(source).toMatch(/MINIONS HALF-INSTALLED[\s\S]{0,400}--yes/);
  });

  test('wedge detection is local to doctor — no statusForVersion import (D19 anti-regression)', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // D19 explicitly chose to extend the existing block in place rather than
    // import statusForVersion, because statusForVersion is per-version only
    // and doesn't encode the cross-version forward-progress override. If a
    // future refactor re-introduces the import this regression guard
    // catches it.
    expect(source).not.toMatch(/import\s*\{\s*statusForVersion\s*\}/);
    expect(source).not.toMatch(/from\s*['"]\.\/apply-migrations\.ts['"]/);
  });

  test('multiple wedged versions chain force-retry calls with &&', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // The local doctor block uses `.join(' && ')` so multiple wedged
    // versions render as a single copy-pasteable command line. Match BOTH
    // engine.ts blocks (local doctor + remote doctor) — the regex finds
    // either occurrence.
    expect(source).toMatch(/wedged\.map\(v\s*=>\s*`gbrain apply-migrations --force-retry [^`]+`\)\.join\(' && '\)/);
  });

  test('remote doctor (doctorReportRemote) also emits the force-retry hint (D14)', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // Check that the wedge detection is duplicated in the remote doctor
    // path so thin-client operators see it. Find the doctorReportRemote
    // function span and verify the wedge-hint code lives inside it.
    const remoteStart = source.indexOf('export async function doctorReportRemote(');
    expect(remoteStart).toBeGreaterThan(0);
    const remoteEnd = source.indexOf('\nexport async function runDoctor(', remoteStart);
    expect(remoteEnd).toBeGreaterThan(remoteStart);
    const remoteBlock = source.slice(remoteStart, remoteEnd);
    expect(remoteBlock).toContain('--force-retry');
    expect(remoteBlock).toContain('partialCount >= 3');
    expect(remoteBlock).toMatch(/WEDGED MIGRATION\(s\) on brain host/);
  });
});

// ============================================================================
// v0.32.4 — sync_freshness check
// ============================================================================
// Pure staleness probe: reads sources.last_sync_at, no filesystem access.
// Drift detection was stripped in v0.32.4 — the doctorReportRemote path runs
// in the HTTP MCP server and walking DB-supplied local_path values from there
// crosses a trust boundary. Drift belongs in multi_source_drift's existing
// guard infrastructure (GBRAIN_DRIFT_LIMIT / GBRAIN_DRIFT_TIMEOUT_MS).
// ============================================================================

describe('v0.32.4 — sync_freshness check', () => {
  // Stub engine: only checkSyncFreshness's executeRaw matters. Per-case rows
  // shape is `{id, name, local_path, last_sync_at}`.
  function makeStubEngine(rows: any[]): any {
    return { executeRaw: async () => rows };
  }

  function agoMs(ms: number): Date {
    return new Date(Date.now() - ms);
  }

  test('empty sources → ok with no-federated-sources message', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const result = await checkSyncFreshness(makeStubEngine([]));
    expect(result.name).toBe('sync_freshness');
    expect(result.status).toBe('ok');
    expect(result.message).toBe('No federated sources to sync');
  });

  test('last_sync_at IS NULL → fail with "never been synced"', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wiki', name: '', local_path: '/tmp/wiki', last_sync_at: null },
    ]));
    expect(result.status).toBe('fail');
    expect(result.message).toContain('never been synced');
    expect(result.message).toContain(`'wiki'`); // source.id embedded
    expect(result.message).toContain('gbrain sync --source <id>');
  });

  test('last_sync_at > 72h ago → fail with day-rounded "Nd ago"', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wiki', name: '', local_path: '/tmp/wiki', last_sync_at: agoMs(4 * 24 * 60 * 60 * 1000) },
    ]));
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/4d ago/);
    expect(result.message).toContain('brain search is stale');
  });

  test('exact 72h boundary → warn (>72h strict; 72h source NOT yet fail)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    // Exactly 72h. Strict `>` on fail threshold means 72h-stale is still in
    // the warn window. The `nowMs` injection pins both clock reads to the
    // same instant — without it, drift between `agoMs` and `Date.now()` in
    // the check pushes ageMs above the threshold and flips the boundary.
    const nowMs = Date.now();
    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wiki', name: '', local_path: '/tmp/wiki', last_sync_at: new Date(nowMs - 72 * 60 * 60 * 1000) },
    ]), { nowMs });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('72h ago');
  });

  test('24h < last_sync_at < 72h → warn with hour-rounded "Nh ago"', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wiki', name: '', local_path: '/tmp/wiki', last_sync_at: agoMs(30 * 60 * 60 * 1000) },
    ]));
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/30h ago/);
  });

  test('exact 24h boundary → ok (>24h strict)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    // Exactly 24h. Strict `>` on warn threshold means 24h-stale is still ok.
    // Same `nowMs` pinning as the 72h boundary test above — both clock reads
    // must hit the same instant or μs-scale drift flips the boundary.
    const nowMs = Date.now();
    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wiki', name: '', local_path: '/tmp/wiki', last_sync_at: new Date(nowMs - 24 * 60 * 60 * 1000) },
    ]), { nowMs });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('synced recently');
  });

  test('last_sync_at <= 24h → ok with "synced recently"', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wiki', name: '', local_path: '/tmp/wiki', last_sync_at: agoMs(2 * 60 * 60 * 1000) },
      { id: 'gstack', name: '', local_path: '/tmp/gstack', last_sync_at: agoMs(60 * 1000) },
    ]));
    expect(result.status).toBe('ok');
    expect(result.message).toContain('2 federated source(s)');
  });

  test('future last_sync_at → warn (clock skew / corrupted timestamp)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    // 10 min in the future. Negative ageMs must NOT fall through as ok.
    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wiki', name: '', local_path: '/tmp/wiki', last_sync_at: new Date(Date.now() + 10 * 60 * 1000) },
    ]));
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/future last_sync_at/);
    expect(result.message).toMatch(/clock skew|corrupted timestamp/);
  });

  test('mixed sources (one fail + one warn) → fail with both issues listed', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wiki', name: '', local_path: '/tmp/wiki', last_sync_at: agoMs(5 * 24 * 60 * 60 * 1000) },
      { id: 'gstack', name: '', local_path: '/tmp/gstack', last_sync_at: agoMs(30 * 60 * 60 * 1000) },
    ]));
    expect(result.status).toBe('fail');
    expect(result.message).toContain(`'wiki'`);
    expect(result.message).toContain(`'gstack'`);
    expect(result.message).toMatch(/5d ago/);
    expect(result.message).toMatch(/30h ago/);
  });

  test('executeRaw throws → outer-catch returns warn (doctor keeps running)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const engine: any = {
      executeRaw: async () => { throw new Error('connection refused'); },
    };
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Could not check sync freshness');
    expect(result.message).toContain('connection refused');
  });

  test('env-var override: GBRAIN_SYNC_FRESHNESS_FAIL_HOURS=6 → 7h-stale fails', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const prev = process.env.GBRAIN_SYNC_FRESHNESS_FAIL_HOURS;
    process.env.GBRAIN_SYNC_FRESHNESS_FAIL_HOURS = '6';
    try {
      const result = await checkSyncFreshness(makeStubEngine([
        { id: 'wiki', name: '', local_path: '/tmp/wiki', last_sync_at: agoMs(7 * 60 * 60 * 1000) },
      ]));
      expect(result.status).toBe('fail');
      expect(result.message).toContain('brain search is stale');
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_SYNC_FRESHNESS_FAIL_HOURS;
      else process.env.GBRAIN_SYNC_FRESHNESS_FAIL_HOURS = prev;
    }
  });

  test('source.id embedded in messages even when source.name is set', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wiki-id', name: 'My Wiki', local_path: '/tmp/wiki', last_sync_at: null },
    ]));
    expect(result.status).toBe('fail');
    // User copy-pastes `gbrain sync --source wiki-id` (NOT "My Wiki"). Message
    // must include the id so the CLI command actually works.
    expect(result.message).toContain(`'wiki-id'`);
  });
});

// ============================================================================
// v0.41.27.0 — sync_freshness git short-circuit (D4 + D6 + D7)
// ============================================================================
// Doctor learns to skip the staleness warning when a git-backed source has no
// new commits since the last sync AND working tree is clean AND chunker
// version matches. Trust boundary preserved via opts.localOnly (D4); count
// math fixed with three buckets that sum to sources.length (D6); narrowed
// predicate mirrors sync.ts:1057+1075 (D7).
// ============================================================================

describe('v0.41.27.0 — sync_freshness git short-circuit', () => {
  // Reuse the stub-engine pattern from v0.32.4 describe above. Row shape now
  // includes last_commit + chunker_version (extended SELECT in v0.41.27.0).
  function makeStubEngine(rows: any[]): any {
    return { executeRaw: async () => rows };
  }
  function agoMs(ms: number): Date {
    return new Date(Date.now() - ms);
  }

  // Probe seams come from src/core/git-head.ts. Reset between each test so
  // case order can't leak state. CURRENT is imported from chunkers/code.ts —
  // tests stay correct across CHUNKER_VERSION bumps.
  let currentChunkerVersion: string;

  beforeEach(async () => {
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    const { CHUNKER_VERSION } = await import('../src/core/chunkers/code.ts');
    currentChunkerVersion = String(CHUNKER_VERSION);
    _setGitHeadProbeForTests(null);
    _setGitCleanProbeForTests(null);
  });

  afterAll(async () => {
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests(null);
    _setGitCleanProbeForTests(null);
  });

  test('case 1: stale + HEAD match + clean tree + chunker match + localOnly=true → ok', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests(() => 'abc123');
    _setGitCleanProbeForTests(() => true);

    const result = await checkSyncFreshness(makeStubEngine([
      {
        id: 'media-corpus', name: '', local_path: '/tmp/media',
        last_sync_at: agoMs(40 * 60 * 60 * 1000),
        last_commit: 'abc123',
        chunker_version: currentChunkerVersion,
      },
    ]), { localOnly: true });

    expect(result.status).toBe('ok');
    // Single-source all-unchanged hits the cold-path message; the
    // "X synced recently, Y unchanged since last sync" mixed-case shape
    // is covered separately in case 6.
    expect(result.message).toContain('no new commits since last sync');
    expect(result.details).toEqual({
      unchanged_count: 1, synced_recently_count: 0, stale_count: 0,
    });
  });

  test('case 2: all stale + all unchanged + localOnly=true → ok cold-path message', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests((path) => path === '/tmp/media' ? 'abc' : 'def');
    _setGitCleanProbeForTests(() => true);

    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'media-corpus', name: '', local_path: '/tmp/media',
        last_sync_at: agoMs(40 * 60 * 60 * 1000),
        last_commit: 'abc', chunker_version: currentChunkerVersion },
      { id: 'archive', name: '', local_path: '/tmp/archive',
        last_sync_at: agoMs(50 * 60 * 60 * 1000),
        last_commit: 'def', chunker_version: currentChunkerVersion },
    ]), { localOnly: true });

    expect(result.status).toBe('ok');
    expect(result.message).toBe(
      'All 2 federated source(s) up to date (no new commits since last sync)',
    );
    expect(result.details).toEqual({
      unchanged_count: 2, synced_recently_count: 0, stale_count: 0,
    });
  });

  test('case 3: stale + HEAD mismatch + localOnly=true → warn (no short-circuit)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests(() => 'NEW-HEAD-SHA');
    _setGitCleanProbeForTests(() => true);

    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wiki', name: '', local_path: '/tmp/wiki',
        last_sync_at: agoMs(30 * 60 * 60 * 1000),
        last_commit: 'OLD-SHA', chunker_version: currentChunkerVersion },
    ]), { localOnly: true });

    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/30h ago/);
    expect(result.details?.unchanged_count).toBe(0);
    expect(result.details?.stale_count).toBe(1);
  });

  test('case 4: stale + matching HEAD + NULL last_commit + localOnly=true → warn (legacy data)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    let headCalls = 0;
    _setGitHeadProbeForTests(() => { headCalls++; return 'abc'; });
    _setGitCleanProbeForTests(() => true);

    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'legacy', name: '', local_path: '/tmp/legacy',
        last_sync_at: agoMs(30 * 60 * 60 * 1000),
        last_commit: null, chunker_version: currentChunkerVersion },
    ]), { localOnly: true });

    expect(result.status).toBe('warn');
    // Helper short-circuits on NULL guard — head probe should NEVER be called.
    expect(headCalls).toBe(0);
    expect(result.details?.stale_count).toBe(1);
  });

  test('case 5: stale + non-git path (head probe returns null) + localOnly=true → warn (fail-open)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests(() => null);  // non-git dir
    _setGitCleanProbeForTests(() => true);

    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'flat-files', name: '', local_path: '/tmp/flat-files',
        last_sync_at: agoMs(30 * 60 * 60 * 1000),
        last_commit: 'abc', chunker_version: currentChunkerVersion },
    ]), { localOnly: true });

    expect(result.status).toBe('warn');
    expect(result.details?.stale_count).toBe(1);
  });

  test('case 6: mixed 3 sources (1 unchanged + 1 synced 5min + 1 truly stale 5d) → fail, three-bucket invariant', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests((path) => {
      if (path === '/tmp/unchanged') return 'frozen-sha';
      if (path === '/tmp/recent') return 'new-sha';   // HEAD differs from last_commit → no short-circuit
      return 'whatever';                                // /tmp/stale: doesn't matter, time path fails
    });
    _setGitCleanProbeForTests(() => true);

    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'unchanged', name: '', local_path: '/tmp/unchanged',
        last_sync_at: agoMs(40 * 60 * 60 * 1000),
        last_commit: 'frozen-sha', chunker_version: currentChunkerVersion },
      { id: 'recent', name: '', local_path: '/tmp/recent',
        last_sync_at: agoMs(5 * 60 * 1000),
        last_commit: 'OLD', chunker_version: currentChunkerVersion },
      { id: 'stale', name: '', local_path: '/tmp/stale',
        last_sync_at: agoMs(5 * 24 * 60 * 60 * 1000),
        last_commit: 'OLD2', chunker_version: currentChunkerVersion },
    ]), { localOnly: true });

    expect(result.status).toBe('fail');
    // Stale source named in the issues list; unchanged + recent are NOT named.
    expect(result.message).toContain(`'stale'`);
    expect(result.message).not.toContain(`'unchanged'`);
    expect(result.message).not.toContain(`'recent'`);
    // Three-bucket invariant: sum === sources.length (the load-bearing assertion).
    expect(result.details).toEqual({
      unchanged_count: 1, synced_recently_count: 1, stale_count: 1,
    });
    const { unchanged_count, synced_recently_count, stale_count } = result.details as any;
    expect(unchanged_count + synced_recently_count + stale_count).toBe(3);
  });

  test('case 7: stale + matching HEAD + clean tree + chunker MISMATCH + localOnly=true → warn (chunker gate fires)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests(() => 'abc');
    _setGitCleanProbeForTests(() => true);

    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'preupgrade', name: '', local_path: '/tmp/pre',
        last_sync_at: agoMs(30 * 60 * 60 * 1000),
        last_commit: 'abc',
        chunker_version: '0',  // STALE — bumped via gbrain upgrade since last sync
      },
    ]), { localOnly: true });

    expect(result.status).toBe('warn');
    expect(result.details?.unchanged_count).toBe(0);
    expect(result.details?.stale_count).toBe(1);
  });

  test('case 8: stale + matching HEAD + DIRTY tree + chunker match + localOnly=true → warn (dirty gate fires)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests(() => 'abc');
    _setGitCleanProbeForTests(() => false);  // dirty

    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'wip', name: '', local_path: '/tmp/wip',
        last_sync_at: agoMs(30 * 60 * 60 * 1000),
        last_commit: 'abc', chunker_version: currentChunkerVersion },
    ]), { localOnly: true });

    expect(result.status).toBe('warn');
    expect(result.details?.unchanged_count).toBe(0);
    expect(result.details?.stale_count).toBe(1);
  });

  test('case 9 — D4 regression: localOnly=false (default) — git probes NEVER called', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    // Probes set up to return "everything matches" — IF they were called,
    // the source would be marked unchanged. Since localOnly defaults false,
    // they MUST NOT fire and the source MUST be flagged stale by time check.
    let headCalls = 0;
    let cleanCalls = 0;
    _setGitHeadProbeForTests(() => { headCalls++; return 'matching-sha'; });
    _setGitCleanProbeForTests(() => { cleanCalls++; return true; });

    // Two callers shapes:
    //   (a) explicit localOnly:false matches doctorReportRemote semantics
    //   (b) omitted opts matches the default-fallthrough path
    for (const opts of [{ localOnly: false }, undefined]) {
      headCalls = 0;
      cleanCalls = 0;
      const result = await checkSyncFreshness(makeStubEngine([
        { id: 'remote-checked', name: '', local_path: '/tmp/x',
          last_sync_at: agoMs(40 * 60 * 60 * 1000),
          last_commit: 'matching-sha', chunker_version: currentChunkerVersion },
      ]), opts);

      // Trust boundary: probes MUST NOT have been called.
      expect(headCalls).toBe(0);
      expect(cleanCalls).toBe(0);
      // And without the short-circuit, time check fires the warn:
      expect(result.status).toBe('warn');
      expect(result.details?.unchanged_count).toBe(0);
      expect(result.details?.stale_count).toBe(1);
    }
  });
});

// ============================================================================
// v0.41.32.0 — commit-relative staleness (supersedes #1623)
// ============================================================================
// Two contracts:
//   T1 (headline bug): a quiet repo whose only "dirt" is untracked files
//       (`?? companies/`, `?? media/`) is now caught up on the LOCAL path —
//       the short-circuit's clean check ignores untracked. Pre-v0.41.30 the
//       strict clean check counted those as dirty → fell through to wall-clock
//       → false SEVERE.
//   T2 (trust boundary): the REMOTE path (no localOnly) computes lag from the
//       stored newest_content_at column and NEVER shells out to git on a
//       DB-supplied local_path (preserves the v0.41.27.0 boundary).
// ============================================================================
describe('v0.41.32.0 — commit-relative staleness', () => {
  function makeStubEngine(rows: any[]): any {
    return { executeRaw: async () => rows };
  }
  function agoMs(ms: number): Date { return new Date(Date.now() - ms); }
  let currentChunkerVersion: string;

  beforeEach(async () => {
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    const { CHUNKER_VERSION } = await import('../src/core/chunkers/code.ts');
    currentChunkerVersion = String(CHUNKER_VERSION);
    _setGitHeadProbeForTests(null);
    _setGitCleanProbeForTests(null);
  });
  afterAll(async () => {
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests(null);
    _setGitCleanProbeForTests(null);
  });

  test('T1: stale + HEAD match + DIRTY-by-untracked-only + localOnly → ok (untracked ignored)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests(() => 'abc123');
    // Clean ONLY when untracked is ignored (the bug scenario: `?? companies/`).
    let sawIgnoreUntracked = false;
    _setGitCleanProbeForTests((_path, ignoreUntracked) => {
      if (ignoreUntracked) { sawIgnoreUntracked = true; return true; }
      return false; // strict mode would call it dirty
    });

    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'media-corpus', name: '', local_path: '/tmp/media',
        last_sync_at: agoMs(86 * 60 * 60 * 1000), // 86h — would be SEVERE on wall-clock
        last_commit: 'abc123', chunker_version: currentChunkerVersion,
        newest_content_at: null },
    ]), { localOnly: true });

    expect(sawIgnoreUntracked).toBe(true); // the short-circuit asked to ignore untracked
    expect(result.status).toBe('ok');
    expect(result.details).toEqual({ unchanged_count: 1, synced_recently_count: 0, stale_count: 0 });
  });

  test('T2: REMOTE (no localOnly) reads column, quiet repo → ok, NO git subprocess', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    let headCalls = 0, cleanCalls = 0;
    _setGitHeadProbeForTests(() => { headCalls++; return 'x'; });
    _setGitCleanProbeForTests(() => { cleanCalls++; return true; });

    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'remote', name: '', local_path: '/tmp/remote',
        last_sync_at: agoMs(100 * 60 * 60 * 1000),
        last_commit: 'x', chunker_version: currentChunkerVersion,
        // Content committed BEFORE the last sync → caught up.
        newest_content_at: agoMs(200 * 60 * 60 * 1000) },
    ])); // NOTE: no { localOnly: true } → remote path

    expect(headCalls).toBe(0);   // trust boundary: no git probe on remote path
    expect(cleanCalls).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.details).toEqual({ unchanged_count: 0, synced_recently_count: 1, stale_count: 0 });
  });

  test('T2b: REMOTE + NULL column → wall-clock fallback → stale (no git subprocess)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } =
      await import('../src/core/git-head.ts');
    let headCalls = 0;
    _setGitHeadProbeForTests(() => { headCalls++; return 'x'; });
    _setGitCleanProbeForTests(() => true);

    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'remote', name: '', local_path: '/tmp/remote',
        last_sync_at: agoMs(100 * 60 * 60 * 1000),
        last_commit: 'x', chunker_version: currentChunkerVersion,
        newest_content_at: null },
    ]));

    expect(headCalls).toBe(0); // still no git probe even on the fallback path
    expect(result.status).toBe('fail'); // 100h wall-clock > 72h
    expect(result.details?.stale_count).toBe(1);
  });

  test('T2c: REMOTE + content NEWER than last sync → wall-clock (genuinely behind)', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const result = await checkSyncFreshness(makeStubEngine([
      { id: 'remote', name: '', local_path: '/tmp/remote',
        last_sync_at: agoMs(100 * 60 * 60 * 1000),
        last_commit: 'x', chunker_version: currentChunkerVersion,
        // committed 10h ago, synced 100h ago → behind.
        newest_content_at: agoMs(10 * 60 * 60 * 1000) },
    ]));
    expect(result.status).toBe('fail');
    expect(result.details?.stale_count).toBe(1);
  });
});

// Supervisor crash classifier wiring. Pre-fix, doctor.ts:1013 counted every
// `worker_exited` event as a crash regardless of `likely_cause`, inflating
// `crashes_24h` to 120+/day from RSS-watchdog drains and SIGTERM stops.
// These tests pin the read-side wiring so doctor and `gbrain jobs supervisor
// status` (jobs.ts:805) cannot drift: both go through `summarizeCrashes`.
describe('supervisor crash classifier wiring (v0.35.x)', () => {
  test('doctor.ts uses summarizeCrashes — no ad-hoc worker_exited filter', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // Wired to the shared helper.
    expect(source).toContain('summarizeCrashes');
    // The pre-fix ad-hoc filter pattern must NOT survive. The exact buggy
    // expression was `events.filter(e => e.event === 'worker_exited').length`.
    // Match the structural fingerprint, not whitespace.
    expect(source).not.toMatch(
      /events\.filter\([^)]*e\.event\s*===\s*'worker_exited'[^)]*\)\.length/,
    );
  });

  test('doctor.ts warn threshold dropped from >3 to >=1', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // The pre-fix `crashes24h > 3` threshold made sense only because the
    // counter was over-counting clean exits. Under accurate counts, any real
    // crash is signal — threshold lands at `>=1`.
    expect(source).toMatch(/crashes24h\s*>=\s*1/);
    // The old `> 3` predicate must not survive on the supervisor check.
    expect(source).not.toMatch(/crashes24h\s*>\s*3/);
  });

  test('doctor.ts ok + warn messages include per-cause breakdown and clean_exits_24h', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // Per-cause breakdown surfaces qualitative signal (oom vs runtime vs unknown
    // vs legacy) so operators can triage without grep'ing JSONL.
    expect(source).toContain('runtime=');
    expect(source).toContain('oom=');
    expect(source).toContain('unknown=');
    expect(source).toContain('legacy=');
    // Clean-exit count surfaces alongside crash count for transparency.
    expect(source).toContain('clean_exits_24h=');
  });

  test('jobs.ts supervisor status uses summarizeCrashes — same wiring as doctor', async () => {
    const source = await Bun.file(new URL('../src/commands/jobs.ts', import.meta.url)).text();
    // Both surfaces MUST go through the shared helper. Without this, the two
    // CLI commands report drifting crash counts (the bug class codex caught
    // during the eng review outside-voice pass).
    expect(source).toContain('summarizeCrashes');
    expect(source).not.toMatch(
      /events\.filter\([^)]*e\.event\s*===\s*'worker_exited'[^)]*\)\.length/,
    );
    // JSON output exposes the per-cause breakdown so dashboards/monitors can
    // distinguish memory pressure from code bugs without re-classifying.
    expect(source).toContain('crashes_by_cause');
    expect(source).toContain('clean_exits_24h');
  });
});

// v0.34.5 stub-guard observability tests (from v0.35.4.0). Doctor surfaces
// the 24h fire count for the resolver-stub-guard. WARN at >10 hits is the
// signal that prefix-expansion in resolveEntitySlug is missing a case.
describe('stub_guard_24h check (v0.34.5)', () => {
  test('doctor source defines the stub_guard_24h check', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toContain("name: 'stub_guard_24h'");
  });

  test('WARN threshold is >10 hits/24h', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // The WARN gate must fire above 10, not at or below — that's the threshold
    // the v0.36 sunset criterion is calibrated against.
    expect(source).toMatch(/events\.length\s*>\s*10/);
  });

  test('fix hint points operators at the audit log', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toContain('stub-guard-*.jsonl');
    expect(source).toContain('prefix-expansion in resolveEntitySlug');
  });

  test('check reads via the dual-week-aware reader (NOT supervisor-audit pattern)', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // The point of the divergence from supervisor-audit.ts is this reader
    // reads both current and previous ISO-week files. If the check ever
    // gets re-pointed at readSupervisorEvents-style single-week, this test
    // fails — protecting the cross-week-boundary correctness.
    expect(source).toContain('readRecentStubGuardEvents');
    expect(source).not.toMatch(/from .*\/stub-guard-audit\.ts.*readSupervisorEvents/);
  });

  test('zero hits emits no check (keeps doctor output clean on healthy brains)', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // The implementation falls through silently when events.length === 0.
    // Codify this in source-grep form so a future refactor doesn't add an
    // "ok: 0 hits" line that pollutes every doctor run.
    expect(source).toMatch(/events\.length === 0|Zero hits is the goal/);
  });
});

describe('v0.40.4 — graph_signals_coverage check', () => {
  const { PGLiteEngine } = require('../src/core/pglite-engine.ts');
  const { checkGraphSignalsCoverage } = require('../src/commands/doctor.ts');

  let engine: any;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();
  });

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  beforeEach(async () => {
    // Wipe pages + links + config between tests for isolation.
    await engine.executeRaw(`DELETE FROM links`);
    await engine.executeRaw(`DELETE FROM pages`);
    await engine.executeRaw(`DELETE FROM config WHERE key IN ('search.graph_signals', 'search.mode')`);
  });

  test('graph_signals disabled (conservative mode) → silent ok regardless of coverage', async () => {
    await engine.setConfig('search.mode', 'conservative');
    // Seed pages without links (would normally warn) but conservative
    // disables graph_signals so the check stays ok.
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`page/${i}`, { type: 'note', title: `page-${i}`, compiled_truth: 'body' });
    }
    const check = await checkGraphSignalsCoverage(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('disabled');
  });

  test('graph_signals enabled (balanced default) + zero links → warn at <10%', async () => {
    // No config set → balanced default (graph_signals=true).
    for (let i = 0; i < 10; i++) {
      await engine.putPage(`page/${i}`, { type: 'note', title: `page-${i}`, compiled_truth: 'body' });
    }
    const check = await checkGraphSignalsCoverage(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('0.0%');
    expect(check.message).toContain('gbrain extract all');
  });

  test('graph_signals enabled + >=30% coverage → ok with metric', async () => {
    for (let i = 0; i < 10; i++) {
      await engine.putPage(`page/${i}`, { type: 'note', title: `page-${i}`, compiled_truth: 'body' });
    }
    // Add inbound links to 4/10 pages = 40%.
    await engine.addLinksBatch([
      { from_slug: 'page/0', to_slug: 'page/1', link_type: 'mentions' },
      { from_slug: 'page/0', to_slug: 'page/2', link_type: 'mentions' },
      { from_slug: 'page/0', to_slug: 'page/3', link_type: 'mentions' },
      { from_slug: 'page/0', to_slug: 'page/4', link_type: 'mentions' },
    ]);
    const check = await checkGraphSignalsCoverage(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('40.0%');
    expect(check.message).toContain('fire on most queries');
  });

  test('graph_signals enabled + 10-29% coverage → ok with occasional-fire note', async () => {
    for (let i = 0; i < 10; i++) {
      await engine.putPage(`page/${i}`, { type: 'note', title: `page-${i}`, compiled_truth: 'body' });
    }
    // Add inbound to 2/10 = 20%.
    await engine.addLinksBatch([
      { from_slug: 'page/0', to_slug: 'page/1', link_type: 'mentions' },
      { from_slug: 'page/0', to_slug: 'page/2', link_type: 'mentions' },
    ]);
    const check = await checkGraphSignalsCoverage(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('20.0%');
    expect(check.message).toContain('fire occasionally');
  });

  test('explicit search.graph_signals=false overrides mode default', async () => {
    // Balanced normally enables; explicit override turns it off.
    await engine.setConfig('search.graph_signals', 'false');
    // No links → would normally warn, but override means we don't check.
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`page/${i}`, { type: 'note', title: `page-${i}`, compiled_truth: 'body' });
    }
    const check = await checkGraphSignalsCoverage(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('disabled');
  });

  test('empty brain → ok with explanation', async () => {
    const check = await checkGraphSignalsCoverage(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Empty brain');
  });

  test('check is wired into runDoctor (source-grep)', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    // Local engine path.
    expect(source).toMatch(/await checkGraphSignalsCoverage\(engine\)/);
    // Remote/JSON path heartbeat.
    expect(source).toContain("progress.heartbeat('graph_signals_coverage')");
  });
});
