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

  // Phase 4D RLS posture — regression guards for service-role-only DB
  // access. The bug is not "RLS off"; it is RLS enabled with zero policies.
  test('RLS check scans ALL public base tables and policy counts', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    const rlsBlock = source.slice(
      source.indexOf('// 5. RLS'),
      source.indexOf('// 6. Schema version'),
    );
    expect(rlsBlock.length).toBeGreaterThan(0);
    expect(rlsBlock).toContain('FROM pg_class c');
    expect(rlsBlock).toContain('FROM pg_policy');
    expect(rlsBlock).toMatch(/n\.nspname\s*=\s*'public'/);
    expect(rlsBlock).toMatch(/c\.relkind\s*=\s*'r'/);
    expect(rlsBlock).not.toMatch(/tablename\s+IN\s*\(/);
  });

  test('RLS check fails on enabled zero-policy trapdoors, not disabled service-role tables', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    const rlsBlock = source.slice(
      source.indexOf('// 5. RLS'),
      source.indexOf('// 6. Schema version'),
    );
    expect(rlsBlock).toContain('No zero-policy RLS trapdoors');
    expect(rlsBlock).toContain('RLS enabled with ZERO policies');
    expect(rlsBlock).toMatch(/status:\s*'fail'/);
    expect(rlsBlock).toContain('DISABLE ROW LEVEL SECURITY');
    expect(rlsBlock).toContain('CREATE POLICY before keeping RLS enabled');
  });

  test('RLS check tracks GBRAIN:RLS_POSTURE comments for disabled tables', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    const rlsBlock = source.slice(
      source.indexOf('// 5. RLS'),
      source.indexOf('// 6. Schema version'),
    );
    expect(rlsBlock).toContain('obj_description');
    expect(rlsBlock).toContain('GBRAIN:RLS_POSTURE');
    expect(rlsBlock).toContain('lack GBRAIN:RLS_POSTURE comments');
  });

  test('RLS check skips on PGLite (embedded single-user, not applicable)', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    const rlsBlock = source.slice(
      source.indexOf('// 5. RLS'),
      source.indexOf('// 6. Schema version'),
    );
    expect(rlsBlock).toMatch(/engine\.kind\s*===\s*'pglite'/);
    expect(rlsBlock).toContain('PGLite');
  });

  // Phase 4D — legacy v35 auto-RLS trigger must stay gone.
  test('rls_event_trigger check expects auto-RLS trigger absence and points at v39 cleanup', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    const idx7 = source.indexOf('// 7. Legacy auto-RLS event trigger');
    const idx8 = source.indexOf('// 8. Embedding health');
    expect(idx7).toBeGreaterThan(0);
    expect(idx8).toBeGreaterThan(idx7);
    const block = source.slice(idx7, idx8);
    expect(block).toContain("name: 'rls_event_trigger'");
    expect(block).toContain('Legacy auto-RLS event trigger absent');
    expect(block).toMatch(/status:\s*'fail'/);
    expect(block).toContain('--force-retry 39');
    expect(block).toMatch(/engine\.kind\s*===\s*'pglite'/);
  });

});
