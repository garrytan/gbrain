/**
 * compile-context core arm: --include-core renders always-loaded core first
 * and records its revision in the header; without it core pages stay out of
 * every arm; core is never written into a git-tracked file; codex-global
 * carries the default source's core in a managed block that --remove-core
 * takes out; hermes writes .hermes.md at the git root and excludes it
 * locally. PGLite in-memory, no DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCompileContext, COMPILED_BLOCK_BEGIN } from '../src/commands/compile-context.ts';
import { compiledCoreRevision, readCompiledCoreRecords } from '../src/core/context/compiled-core.ts';

let engine: PGLiteEngine;
let cwd: string;
let fakeHome: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ['HOME', 'GBRAIN_HOME', 'GBRAIN_SOURCE', 'AGENT_VOICE_PII_BLOCKLIST', 'CODEX_HOME']) saved[key] = process.env[key];
  fakeHome = mkdtempSync(join(tmpdir(), 'compile-core-home-'));
  process.env.HOME = fakeHome;
  process.env.GBRAIN_HOME = fakeHome;
  process.env.CODEX_HOME = join(fakeHome, '.codex');
  delete process.env.GBRAIN_SOURCE;
  delete process.env.AGENT_VOICE_PII_BLOCKLIST;
  cwd = mkdtempSync(join(tmpdir(), 'compile-core-ws-'));
  execFileSync('git', ['init', '-q'], { cwd });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('memory.core.enabled', 'true');
  await engine.putPage('people/ada-example', { type: 'note', title: 'Ada Example', compiled_truth: 'A collaborator profile used by the compile fixtures.' });
  await engine.putPage('concepts/core-prefs', {
    type: 'note', title: 'Working preferences', compiled_truth: 'Prefers short answers with the command to run.',
    frontmatter: { always_load: true },
  });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stdout.write);
  const se = spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => { err.push(String(c)); return true; }) as typeof process.stderr.write);
  try {
    return { code: await runCompileContext(engine, args, { cwd }), stdout: out.join(''), stderr: err.join('') };
  } finally { so.mockRestore(); se.mockRestore(); }
}

describe('compile-context core arm', () => {
  test('without --include-core, core pages stay out of every arm and the header has no core', async () => {
    const r = await run(['--target', 'claude-code', '--stdout']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('people/ada-example');
    expect(r.stdout).not.toContain('core-prefs');
    expect(compiledCoreRevision(r.stdout)).toBeNull();
  });

  test('--include-core renders core first in full, records the revision and the refresh command, byte-stable', async () => {
    const a = await run(['--target', 'claude-code', '--stdout', '--include-core']);
    const b = await run(['--target', 'claude-code', '--stdout', '--include-core']);
    expect(a.code).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    expect(compiledCoreRevision(a.stdout)).toMatch(/^[0-9a-f]{16}$/);
    expect(a.stdout).toContain('refresh="gbrain compile-context --target claude-code --include-core"');
    const coreAt = a.stdout.indexOf('Prefers short answers');
    expect(coreAt).toBeGreaterThan(0);
    expect(coreAt).toBeLessThan(a.stdout.indexOf('people/ada-example'));
    expect(a.stdout.match(/core-prefs/g)?.length).toBe(1);
  });

  test('core is refused for a git-tracked output file', async () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# repo agents\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd });
    const r = await run(['--target', 'codex', '--include-core']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('tracked by git');
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe('# repo agents\n');
  });

  test('codex-global writes the default core block into $CODEX_HOME/AGENTS.md; --remove-core takes it out', async () => {
    const path = join(fakeHome, '.codex', 'AGENTS.md');
    const r = await run(['--target', 'codex-global']);
    expect(r.code).toBe(0);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(COMPILED_BLOCK_BEGIN);
    expect(text).toContain('Prefers short answers');
    expect(text).not.toContain('people/ada-example');
    expect(readCompiledCoreRecords().map(x => x.target)).toContain('codex-global');
    writeFileSync(path, `# my notes\n${readFileSync(path, 'utf8')}`);
    expect((await run(['--target', 'codex-global', '--remove-core'])).code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('# my notes\n');
    expect(readCompiledCoreRecords().map(x => x.target)).not.toContain('codex-global');
  });

  test('hermes writes .hermes.md at the git root and excludes it locally', async () => {
    const r = await run(['--target', 'hermes', '--include-core']);
    expect(r.code).toBe(0);
    expect(existsSync(join(cwd, '.hermes.md'))).toBe(true);
    expect(readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')).toContain('/.hermes.md');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })).not.toContain('.hermes.md');
  });
});

describe('core_memory doctor check sees compiled copies', () => {
  test('a compiled file with an older core revision is named with its refresh command', async () => {
    const { coreMemoryCheck } = await import('../src/commands/doctor/checks/core-memory.ts');
    expect((await run(['--target', 'claude-code', '--include-core'])).code).toBe(0);
    expect((await coreMemoryCheck(engine)).message).not.toContain('older core revision');
    await engine.putPage('concepts/core-prefs', {
      type: 'note', title: 'Working preferences', compiled_truth: 'Prefers short answers; always include the command.',
      frontmatter: { always_load: true },
    });
    const check = await coreMemoryCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain-context.md carries an older core revision; refresh it with gbrain compile-context --target claude-code --include-core');
  });
});
