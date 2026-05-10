import { describe, test, expect } from 'bun:test';

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
