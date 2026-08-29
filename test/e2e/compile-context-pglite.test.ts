/**
 * compile-context e2e (cathedral-5, plan D3'/D4') — PGLite in-memory, no
 * DATABASE_URL. Pins, in order: empty-brain header-only; double-run byte
 * identity; meta honesty (whole-output tokens <= budget); world-grade
 * fences (private fence rows never reach compiled output); scan drops
 * reported + .gbrain-scan-allow un-drops; check-mode exit codes (0 same /
 * 1 diff / 2 error); the claude-code file + import instruction; codex
 * AGENTS.md splice idempotency + damaged-marker abort; and the dup-slug
 * cross-source pin (the source flag compiles the right page).
 *
 * Tests run in declaration order: the empty-brain pin runs BEFORE seeding.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  runCompileContext,
  COMPILED_BLOCK_BEGIN,
  COMPILED_BLOCK_END,
} from '../../src/commands/compile-context.ts';
import { SCAN_ALLOW_FILENAME } from '../../src/core/secret-scan.ts';
import { estimateTokens } from '../../src/core/search/token-budget.ts';

let engine: PGLiteEngine;
let cwd: string;
let fakeHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Isolation: the sensitivity scan reads the operator pattern file under
  // the real home and the blocklist from the environment — both must not
  // bleed into this suite.
  for (const key of ['HOME', 'GBRAIN_SOURCE', 'AGENT_VOICE_PII_BLOCKLIST']) {
    savedEnv[key] = process.env[key];
  }
  fakeHome = mkdtempSync(join(tmpdir(), 'compile-ctx-home-'));
  process.env.HOME = fakeHome;
  delete process.env.GBRAIN_SOURCE;
  delete process.env.AGENT_VOICE_PII_BLOCKLIST;

  cwd = mkdtempSync(join(tmpdir(), 'compile-ctx-ws-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

async function run(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const se = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    const code = await runCompileContext(engine, args, { cwd });
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
}

const PRIVATE_FACT = 'PRIVATE-MARKER-FACT-zebra-holdings';

describe('compile-context e2e (PGLite)', () => {
  test(
    'empty brain compiles header-only, exit 0',
    async () => {
      const r = await run(['--target', 'claude-code', '--stdout']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('<!-- gbrain:compiled-context digest=sha256:');
      expect(r.stdout).not.toContain('## ');
      expect(r.stdout).not.toContain('no entries fit'); // empty, not over-budget
    },
    // First compile pays the one-time module-graph + first-PGLite-query
    // warmup (~6s on CI-class hardware); later tests run in milliseconds.
    30_000,
  );

  test('seed fixture pages', async () => {
    await engine.putPage('concepts/orbit', {
      type: 'note',
      title: 'Orbital mechanics',
      compiled_truth: 'A concise principle about orbital transfer windows. Extra detail.',
    });
    await engine.putPage('people/ada-model', {
      type: 'note',
      title: 'Ada Example',
      compiled_truth: 'A collaborator profile used by the compile fixtures.',
    });
    await engine.putPage('originals/manifesto', {
      type: 'note',
      title: 'The Manifesto',
      compiled_truth: [
        '<!--- gbrain:facts:begin -->',
        '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
        '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
        `| 1 | ${PRIVATE_FACT} | fact | 1.0 | private | high |  |  |  |  |`,
        '| 2 | The manifesto is public knowledge | fact | 1.0 | world | high |  |  |  |  |',
        '<!--- gbrain:facts:end -->',
        '',
        'World-visible prose sentence for the manifesto.',
      ].join('\n'),
    });
    const seeded = await engine.listPages({ sourceId: 'default' });
    expect(seeded.length).toBe(3);
  });

  test('double run yields identical bytes; meta is honest; output fits the budget', async () => {
    const a = await run(['--target', 'claude-code', '--stdout']);
    const b = await run(['--target', 'claude-code', '--stdout']);
    expect(a.code).toBe(0);
    expect(b.stdout).toBe(a.stdout);

    const j = await run(['--target', 'claude-code', '--stdout', '--json', '--budget', '500']);
    expect(j.code).toBe(0);
    const env = JSON.parse(j.stdout);
    expect(env.requested_budget).toBe(500);
    expect(env.entries_used).toBeGreaterThan(0);
    expect(env.kept).toBe(env.entries_used);
    expect(env.total_output_tokens).toBeLessThanOrEqual(500);
    expect(estimateTokens(env.text)).toBeLessThanOrEqual(500);
    expect(Array.isArray(env.scan_drops)).toBe(true);
    expect(typeof env.generated_at).toBe('string');
  });

  test('world-grade fences: private fence rows never reach compiled output', async () => {
    const r = await run(['--target', 'claude-code', '--stdout']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('originals/manifesto'); // page compiled
    expect(r.stdout).not.toContain(PRIVATE_FACT); // private row stripped
  });

  test('scan drop is reported (slug + family, never the text) and .gbrain-scan-allow un-drops it', async () => {
    await engine.putPage('concepts/leaky', {
      type: 'note',
      title: 'Leaky page',
      compiled_truth: 'Contact droptest@example.com for access.',
    });

    const dropped = await run(['--target', 'claude-code', '--stdout', '--json']);
    expect(dropped.code).toBe(0);
    const env = JSON.parse(dropped.stdout);
    expect(env.scan_drops.length).toBe(1);
    expect(env.scan_drops[0].slug).toBe('concepts/leaky');
    expect(env.scan_drops[0].family).toBe('pii:email');
    expect(env.text).not.toContain('concepts/leaky');
    expect(env.text).not.toContain('droptest@example.com');
    expect(dropped.stderr).toContain('concepts/leaky');
    expect(dropped.stderr).toContain('pii:email');
    expect(dropped.stderr).not.toContain('droptest@example.com');

    // The uniform escape hatch: allowlist the fingerprint, entry compiles.
    writeFileSync(join(cwd, SCAN_ALLOW_FILENAME), `${env.scan_drops[0].fingerprint}\n`);
    const undropped = await run(['--target', 'claude-code', '--stdout', '--json']);
    const env2 = JSON.parse(undropped.stdout);
    expect(env2.scan_drops.length).toBe(0);
    expect(env2.text).toContain('concepts/leaky');
    rmSync(join(cwd, SCAN_ALLOW_FILENAME));

    // Keep the corpus clean for the remaining byte-stability pins.
    await engine.deletePage('concepts/leaky');
  });

  test('claude-code target writes .claude/gbrain-context.md + prints the import line', async () => {
    const r = await run(['--target', 'claude-code']);
    expect(r.code).toBe(0);
    const path = join(cwd, '.claude', 'gbrain-context.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('gbrain:compiled-context');
    expect(r.stdout).toContain('@.claude/gbrain-context.md');
  });

  test('check mode: 0 when fresh, 1 after the brain changes, 0 after recompile', async () => {
    const fresh = await run(['--target', 'claude-code', '--check']);
    expect(fresh.code).toBe(0);

    await engine.putPage('concepts/new-arrival', {
      type: 'note',
      title: 'New arrival',
      compiled_truth: 'A newly written page moves the anchor and the digest.',
    });
    const stale = await run(['--target', 'claude-code', '--check']);
    expect(stale.code).toBe(1);

    const rewrite = await run(['--target', 'claude-code']);
    expect(rewrite.code).toBe(0);
    const recheck = await run(['--target', 'claude-code', '--check']);
    expect(recheck.code).toBe(0);
  });

  test('codex target splices AGENTS.md, preserves user prose, and is idempotent', async () => {
    const agentsPath = join(cwd, 'AGENTS.md');
    writeFileSync(agentsPath, '# My agents file\n\nHand-written guidance stays.\n');

    const first = await run(['--target', 'codex']);
    expect(first.code).toBe(0);
    const afterFirst = readFileSync(agentsPath, 'utf-8');
    expect(afterFirst).toContain('# My agents file');
    expect(afterFirst).toContain('Hand-written guidance stays.');
    expect(afterFirst).toContain(COMPILED_BLOCK_BEGIN);
    expect(afterFirst).toContain(COMPILED_BLOCK_END);
    expect(afterFirst).toContain('gbrain:compiled-context digest=sha256:');

    const second = await run(['--target', 'codex']);
    expect(second.code).toBe(0);
    expect(readFileSync(agentsPath, 'utf-8')).toBe(afterFirst); // idempotent

    const check = await run(['--target', 'codex', '--check']);
    expect(check.code).toBe(0);
  });

  test('codex damaged markers abort with exit 2 and leave the file untouched', async () => {
    const agentsPath = join(cwd, 'AGENTS.md');
    const damaged = `${COMPILED_BLOCK_BEGIN}\nstuff\n${COMPILED_BLOCK_BEGIN}\nmore\n${COMPILED_BLOCK_END}\n`;
    writeFileSync(agentsPath, damaged);

    const r = await run(['--target', 'codex']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('damaged');
    expect(readFileSync(agentsPath, 'utf-8')).toBe(damaged); // no partial write

    const check = await run(['--target', 'codex', '--check']);
    expect(check.code).toBe(2);
    rmSync(agentsPath);
  });

  test('dup slug across sources: the source flag compiles the right page', async () => {
    for (const id of ['alpha-src', 'beta-src']) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, created_at)
         VALUES ($1, $1, '/fake/${id}', '{}'::jsonb, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [id],
      );
    }
    await engine.putPage(
      'concepts/shared-slug',
      {
        type: 'note',
        title: 'Shared (alpha)',
        compiled_truth: 'Alpha source body sentence.',
      },
      { sourceId: 'alpha-src' },
    );
    await engine.putPage(
      'concepts/shared-slug',
      {
        type: 'note',
        title: 'Shared (beta)',
        compiled_truth: 'Beta source body sentence.',
      },
      { sourceId: 'beta-src' },
    );

    const beta = await run(['--target', 'claude-code', '--stdout', '--source', 'beta-src']);
    expect(beta.code).toBe(0);
    expect(beta.stdout).toContain('Beta source body sentence.');
    expect(beta.stdout).not.toContain('Alpha source body sentence.');

    const alpha = await run(['--target', 'claude-code', '--stdout', '--source', 'alpha-src']);
    expect(alpha.stdout).toContain('Alpha source body sentence.');
    expect(alpha.stdout).not.toContain('Beta source body sentence.');
  });

  test('usage errors exit 2: missing target, unknown target, bad budget', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['--target', 'claude'])).code).toBe(2); // bootstrap spelling required
    expect((await run(['--target', 'claude-code', '--budget', 'lots'])).code).toBe(2);
  });
});

describe('spliceCompiledBlock negatives (pre-landing review pins)', () => {
  test('orphan begin, orphan end, and end-before-begin all throw; no-marker appends', async () => {
    const { spliceCompiledBlock, COMPILED_BLOCK_BEGIN, COMPILED_BLOCK_END } =
      await import('../../src/commands/compile-context.ts');
    const block = `${COMPILED_BLOCK_BEGIN}\nnew\n${COMPILED_BLOCK_END}`;
    // No markers: appended, surrounding content preserved.
    const appended = spliceCompiledBlock('# Agents\n\nhand-written\n', block);
    expect(appended).toContain('hand-written');
    expect(appended).toContain('new');
    // Orphan begin.
    expect(() => spliceCompiledBlock(`x\n${COMPILED_BLOCK_BEGIN}\ny\n`, block)).toThrow();
    // Orphan end.
    expect(() => spliceCompiledBlock(`x\n${COMPILED_BLOCK_END}\ny\n`, block)).toThrow();
    // End before begin (out of order).
    expect(() =>
      spliceCompiledBlock(`${COMPILED_BLOCK_END}\nmid\n${COMPILED_BLOCK_BEGIN}\n`, block),
    ).toThrow(/out of order|markers/i);
  });

  test('marker-equal lines INSIDE the compiled body are neutralized (no self-wedge)', async () => {
    const { spliceCompiledBlock, COMPILED_BLOCK_BEGIN, COMPILED_BLOCK_END } =
      await import('../../src/commands/compile-context.ts');
    // A page excerpt that is exactly a marker string (adversarial review):
    // unneutralized, the first splice writes a file with 1 begin / 2 end
    // markers and every later run throws until AGENTS.md is hand-edited.
    const poisoned = `header line\n${COMPILED_BLOCK_END}\n${COMPILED_BLOCK_BEGIN}\ntail line`;
    const first = spliceCompiledBlock('# Agents\n', poisoned);
    // The managed block still has exactly one of each marker at line level...
    const lines = first.split('\n');
    expect(lines.filter((l) => l === COMPILED_BLOCK_BEGIN)).toHaveLength(1);
    expect(lines.filter((l) => l === COMPILED_BLOCK_END)).toHaveLength(1);
    // ...the poisoned text is still visible (leading space, not deleted)...
    expect(first).toContain(` ${COMPILED_BLOCK_END}`);
    expect(first).toContain(` ${COMPILED_BLOCK_BEGIN}`);
    // ...and a SECOND splice over the written file succeeds (idempotent, no wedge).
    const second = spliceCompiledBlock(first, poisoned);
    expect(second).toBe(first);
  });
});
