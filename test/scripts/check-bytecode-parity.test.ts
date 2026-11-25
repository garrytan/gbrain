/**
 * The release binary is compiled with `--bytecode --format=esm`, and
 * scripts/check-bytecode-parity.ts proves that build prints the same output as
 * a plain one. These cases pin the flags on every shipped compile line, the
 * check's reading of the release line, and that its masks hide only run-to-run
 * noise. The build-and-compare itself runs as a test.yml verify-job step.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedDiff, BYTECODE_FLAGS, makeWorkDir, NORMALIZE, releaseCompileArgs, STEPS, stepProblems } from '../../scripts/check-bytecode-parity.ts';

const ROOT = join(import.meta.dir, '..', '..');
const RELEASE = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
const BYTECODE = BYTECODE_FLAGS.join(' ');

describe('bytecode release build', () => {
  test('every shipped compile line carries --bytecode --format=esm (plain --bytecode builds CommonJS, which cannot hold top-level await)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const lines = [pkg.scripts.build!, ...pkg.scripts['build:all']!.split('&&'), ...RELEASE.split('\n').filter(l => l.includes('bun build --compile'))];
    expect(lines.length).toBe(4);
    for (const l of lines) expect(l).toContain(`bun build --compile ${BYTECODE} `);
  });

  test('the check builds the release line itself, for this host, with our output path and commit', () => {
    const args = releaseCompileArgs(RELEASE, '/out/gbrain', 'c0ffee');
    expect(args.slice(0, 2)).toEqual(['build', '--compile']);
    expect(args).toContain('--bytecode');
    expect(args).toContain('--format=esm');
    expect(args).toContain('--no-compile-autoload-bunfig');
    expect(args.some(a => a.startsWith('--target'))).toBe(false);
    expect(args[args.indexOf('--outfile') + 1]).toBe('/out/gbrain');
    expect(args[args.indexOf('--define') + 1]).toBe('GBRAIN_BUILD_COMMIT="c0ffee"');
    expect(args.slice(-2)).toEqual(['src/cli.ts', 'src/core/skills/resolver/hook-worker.ts']);
  });

  test('the masks hide clock, ids and timings, and nothing else', () => {
    const a = '{"at":"2026-11-24T19:27:16.677Z","revision":"48593de4-1e6c-4a2d-baaf-d89fb3fdc6fc","elapsed_ms":12,"score":0.5153364768260927} took 1.2s on 127.0.0.1:4100';
    const b = '{"at":"2026-11-24T19:27:48.141Z","revision":"2832db84-f262-44a2-bb00-ea174a7cb95d","elapsed_ms":9,"score":0.5153365300173905} took 0.9s on 127.0.0.1:4100';
    expect(NORMALIZE(a, 4100)).toBe(NORMALIZE(b, 4100));
    expect(NORMALIZE('score 0.51533', 1)).not.toBe(NORMALIZE('score 0.51633', 1));
    expect(NORMALIZE('{"page_count":2}', 1)).not.toBe(NORMALIZE('{"page_count":3}', 1));
    expect(NORMALIZE('Usage: gbrain put <slug>', 1)).toBe('Usage: gbrain put <slug>');
  });

  test('a clock-driven decimal that crosses a rounding boundary between the runs matches; a real difference fails and prints a bounded diff', () => {
    const query = STEPS.find(s => s.name === 'query')!;
    const out = (score: string, boost: string) => ({ stdout: `[{"slug":"notes/alpha",\n"score": ${score},\n"cosine": 0.19518001959264342,\n"recency_boost": ${boost}}]\n`, stderr: '', status: 0 });
    expect(stepProblems(query, out('0.9861199999943636', '1.2999997336422118'), out('0.9861200005943636', '1.29999988711424'), 1)).toEqual([]);
    const [plain, bytecode] = [out('0.9861200055943636', '1.2999997336422118'), out('0.9871200055943636', '1.29999988711424')];
    expect(stepProblems(query, plain, bytecode, 1)).toEqual(['stdout differs']);
    expect(stepProblems(query, out('123456.1234567', '1.2999997336422118'), out('123457.0000000', '1.2999997336422118'), 1)).toEqual(['stdout differs']);
    expect(boundedDiff(plain.stdout, bytecode.stdout, 1).split('\n')).toEqual([
      '--- plain', '+++ bytecode', '@@ -1,4 +1,4 @@', ' [{"slug":"notes/alpha",', '-"score": 0.9861200055943636,', '+"score": 0.9871200055943636,', ' "cosine": 0.19518001959264342,', ' "recency_boost": 1.2999997336422118}]',
    ]);
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    expect(boundedDiff(long, long.replaceAll('line', 'LINE'), 1).split('\n').length).toBe(61);
  });

  test('a step fails when both builds fail, hang or skip its path the same way, not only when they differ', () => {
    const mcp = STEPS.find(s => s.name === 'mcp-tools-list')!;
    const ok = { stdout: '{"name":"get_page"}', stderr: '', status: 0 };
    expect(stepProblems(mcp, ok, ok, 1)).toEqual([]);
    const killed = { ...ok, status: null };
    expect(stepProblems(mcp, killed, killed, 1)).toEqual(['exit plain=null bytecode=null, expected 0']);
    const refused = { stdout: '', stderr: 'Error', status: 3 };
    expect(stepProblems(STEPS.find(s => s.name === 'embed')!, refused, refused, 1)).toEqual(['exit plain=3 bytecode=3, expected 0', 'stdout lacks Embedded (the step did not run its path)']);
    expect(stepProblems(mcp, ok, { ...ok, stderr: 'warn' }, 1)).toEqual(['stderr differs']);
    for (const s of STEPS) expect({ step: s.name, exit: s.exit ?? 0 }).toEqual({ step: s.name, exit: 0 });
  });

  test('the work directory is a real path when the temp folder is a symlink (macOS /var/folders)', () => {
    const real = mkdtempSync(join(tmpdir(), 'parity-real-'));
    const link = `${real}-link`;
    symlinkSync(real, link);
    try {
      const work = makeWorkDir(link);
      expect(work.startsWith(realpathSync(real))).toBe(true);
      expect(work).toBe(realpathSync(work));
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  test('pull requests run the check in the verify job', () => {
    const verify = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8').split('\n  verify:\n')[1]!.split('\n  typecheck:\n')[0]!;
    expect(verify).toContain('run: bun scripts/check-bytecode-parity.ts');
  });
});
