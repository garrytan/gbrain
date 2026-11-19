/**
 * Real CLI against a fresh `foresights init --pglite` brain (a managed brain):
 * - #5877: the command doctor's `orphan_ratio` hint prints runs and exits 0
 *   (the bare `--by-mention` hint exited 2 on the default fs source).
 * - #5904 probe (E28, GBRA-40): `extract timeline --source db` no longer
 *   reports "rows lost" and exits 0 over refused writes; it writes through
 *   the coordinator and leaves the rows import stored untouched.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDoctor, type DoctorReport } from '../src/commands/doctor.ts';
import { setCliOptions } from '../src/core/cli-options.ts';

const REPO = join(import.meta.dir, '..');
let home: string;

function cli(args: string[], input?: string) {
  const r = spawnSync('bun', ['run', join(REPO, 'src/cli.ts'), ...args], {
    cwd: home,
    input,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env, GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_SKILL_NAG: '1',
    } as NodeJS.ProcessEnv,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The fix command doctor prints for a high orphan ratio, from a seeded in-memory brain. */
async function doctorHintCommand(): Promise<string> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
  for (let i = 0; i < 100; i++) {
    await engine.putPage(`people/person-${i}`, { type: 'person', title: `Person ${i}`, compiled_truth: 'b', timeline: '', frontmatter: {} });
  }
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  const exit = process.exit;
  console.log = (msg?: unknown) => { out.push(String(msg)); };
  console.error = () => {};
  (process as { exit: unknown }).exit = (() => { throw new Error('__exit'); }) as unknown as typeof process.exit;
  try {
    await runDoctor(engine, ['--json']);
  } catch (e) {
    if (!(e instanceof Error && e.message === '__exit')) throw e;
  } finally {
    console.log = log; console.error = err; (process as { exit: unknown }).exit = exit;
    await engine.disconnect();
  }
  for (let i = out.length - 1; i >= 0; i--) {
    try {
      const report = JSON.parse(out[i]!) as DoctorReport;
      const check = report.checks?.find(c => c.name === 'orphan_ratio');
      const match = check?.message.match(/Run: ((?:foresights|gbrain) extract links[^(]*?)\s{2,}/);
      if (match) return match[1]!.trim();
    } catch { /* not the report */ }
  }
  throw new Error('orphan_ratio hint not found');
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-fresh-db-extract-'));
  const init = cli(['init', '--pglite', '--no-embedding', '--non-interactive']);
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const put = cli(['put', 'people/alice-example'],
    '---\ntitle: Alice Example\ntype: person\n---\nAlice works at Acme.\n\n## Timeline\n\n- **2024-01-05** | Joined Acme as CTO\n- **2024-03-01** | Shipped v2\n');
  if (put.status !== 0) throw new Error(`put failed: ${put.stderr}`);
}, 240_000);

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe('fresh foresights init brain', () => {
  test('#5877: the printed orphan_ratio fix command runs and exits 0', async () => {
    const command = await doctorHintCommand();
    expect(command).toBe('foresights extract links --by-mention --source db');
    const r = cli(command.split(' ').slice(1));
    expect(r.stderr).not.toContain('requires --source db');
    expect(r.status).toBe(0);
  }, 240_000);

  test('#5904: extract timeline --source db is honest and keeps the rows import stored', () => {
    const before = cli(['timeline', 'people/alice-example']);
    expect(before.stdout).toContain('Joined Acme as CTO');
    expect(before.stdout).toContain('Shipped v2');
    const r = cli(['extract', 'timeline', '--source', 'db']);
    expect(r.stderr).not.toContain('rows lost');
    expect(r.stderr).not.toContain('refused');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Timeline: created 0 entries from 1 pages (db source)');
    const after = cli(['timeline', 'people/alice-example']);
    expect(after.stdout).toContain('Joined Acme as CTO');
    expect(after.stdout).toContain('Shipped v2');
  }, 240_000);
});
