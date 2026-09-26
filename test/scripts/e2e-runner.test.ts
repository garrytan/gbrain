import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = join(import.meta.dir, '../..');
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-e2e-runner-'));
  for (const dir of ['scripts/lib', 'test/e2e', 'bin']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['run-e2e.sh', 'sharding.ts', 'lib/test-env.sh']) copyFileSync(join(repo, 'scripts', file), join(root, 'scripts', file));
  for (const name of ['a', 'b']) writeFileSync(join(root, `test/e2e/${name}.test.ts`), `import {test,expect} from 'bun:test'; test('isolated routing',()=>{ expect(process.env.SHARD).toBeUndefined(); expect(process.env.COVERAGE_DIR ?? '').toBe(''); });`);
  return root;
}
for (const githubActions of ['', 'true']) describe(`sequential E2E runner (GITHUB_ACTIONS=${githubActions})`, () => {
  const env = { ...process.env, GITHUB_ACTIONS: githubActions, GBRAIN_NO_SNAPSHOT: '1', DATABASE_URL: '', GBRAIN_DATABASE_URL: '', SHARD: '', COVERAGE_DIR: '' };
  function run(root: string, args: string[], shard = '') {
    return spawnSync('bash', ['scripts/run-e2e.sh', ...args], { cwd: root, encoding: 'utf8', env: { ...env, SHARD: shard } });
  }
  test('weighted shards cover exactly the explicit input; empty shards launch nothing', () => {
    const root = setup();
    try {
      const files = ['test/e2e/a.test.ts', 'test/e2e/b.test.ts'];
      const selected = [1, 2, 3].flatMap(n => {
        const r = run(root, ['--dry-run-list', ...files], `${n}/3`);
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim().split('\n').filter(Boolean);
      });
      expect(selected.sort()).toEqual(files);
      expect(run(root, files, '3/3').stdout).toContain('No files for shard 3/3');
      for (const bad of ['2', '0/2', '3/2', '1/0', '1/2x', '1/2/3']) expect(run(root, files, bad).status).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('runs each file and preserves an assertion failure in the final status', () => {
    const root = setup();
    try {
      const files = ['test/e2e/a.test.ts', 'test/e2e/b.test.ts'];
      const good = run(root, files, '1/1');
      expect(good.status, good.stderr + good.stdout).toBe(0);
      expect(good.stdout).toContain('Files: 2 total, 2 passed, 0 failed');
      writeFileSync(join(root, files[0]), "import {test,expect} from 'bun:test';test('failure',()=>expect(1).toBe(2));");
      const bad = run(root, files);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain('Files: 2 total, 1 passed, 1 failed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('coverage keeps fresh processes, disjoint LCOV directories, shard identity and successful execution receipts', () => {
    const root = setup();
    try {
      const coverage = join(root, 'coverage');
      const files = ['test/e2e/a.test.ts', 'test/e2e/b.test.ts'];
      writeFileSync(join(root, 'bin/git'), '#!/bin/sh\nprintf fixture-commit\n', { mode: 0o755 });
      writeFileSync(join(root, 'test/e2e/source.ts'), 'export const answer = () => 42;');
      for (const file of files) writeFileSync(join(root, file), `import {test,expect} from 'bun:test';
import {appendFileSync} from 'node:fs';
import {answer} from './source';
test('fresh process',()=>{
  expect(process.env.SHARD).toBeUndefined();
  expect((globalThis as any).priorFile).toBeUndefined();
  (globalThis as any).priorFile = true;
  expect(answer()).toBe(42);
  appendFileSync(${JSON.stringify(join(root, 'pids.txt'))}, process.pid+'\\n');
});`);
      const coverageEnv = { ...env, SHARD: '1/1', COVERAGE_DIR: coverage, PATH: `${join(root, 'bin')}:${process.env.PATH}` };
      const good = spawnSync('bash', ['scripts/run-e2e.sh', ...files], { cwd: root, env: coverageEnv, encoding: 'utf8' });
      expect(good.status, good.stdout + good.stderr).toBe(0);
      expect(new Set(readFileSync(join(root, 'pids.txt'), 'utf8').trim().split('\n')).size).toBe(2);
      expect(existsSync(join(coverage, 'e2e-1/lcov.info'))).toBe(true);
      expect(existsSync(join(coverage, 'e2e-2/lcov.info'))).toBe(true);
      expect(JSON.parse(readFileSync(join(coverage, 'lane-manifest.json'), 'utf8'))).toEqual({ lane: 'e2e-1', sha: 'fixture-commit', lcovCount: 2, complete: true });
      expect(readFileSync(join(coverage, 'executed-files.txt'), 'utf8').trim().split('\n').sort()).toEqual(files);
      const shorterCoverage = join(root, 'shorter-coverage');
      const shorter = spawnSync('bash', ['scripts/run-e2e.sh', files[0]], { cwd: root, env: { ...coverageEnv, COVERAGE_DIR: shorterCoverage }, encoding: 'utf8' });
      expect(shorter.status, shorter.stdout + shorter.stderr).toBe(0);
      expect(existsSync(join(shorterCoverage, 'e2e-2/lcov.info'))).toBe(false);
      expect(JSON.parse(readFileSync(join(shorterCoverage, 'lane-manifest.json'), 'utf8')).lcovCount).toBe(1);
      expect(readFileSync(join(shorterCoverage, 'executed-files.txt'), 'utf8')).toBe(files[0] + '\n');
      writeFileSync(join(root, files[0]), "import {test} from 'bun:test';test.skip('optional',()=>{});");
      const skippedCoverage = join(root, 'skipped-coverage');
      const skipped = spawnSync('bash', ['scripts/run-e2e.sh', files[0]], { cwd: root, env: { ...coverageEnv, COVERAGE_DIR: skippedCoverage }, encoding: 'utf8' });
      expect(skipped.status, skipped.stdout + skipped.stderr).toBe(0);
      expect(existsSync(join(skippedCoverage, 'e2e-1/lcov.info'))).toBe(false);
      expect(JSON.parse(readFileSync(join(skippedCoverage, 'lane-manifest.json'), 'utf8')).lcovCount).toBe(0);
      expect(existsSync(join(coverage, 'e2e-2/lcov.info'))).toBe(true);
      expect(JSON.parse(readFileSync(join(coverage, 'lane-manifest.json'), 'utf8')).lcovCount).toBe(2);
      writeFileSync(join(root, files[0]), "import {test,expect} from 'bun:test';test('failure',()=>expect(1).toBe(2));");
      const failedCoverage = join(root, 'failed-coverage');
      const bad = spawnSync('bash', ['scripts/run-e2e.sh', ...files], { cwd: root, env: { ...coverageEnv, COVERAGE_DIR: failedCoverage }, encoding: 'utf8' });
      expect(bad.status).toBe(1);
      expect(existsSync(join(failedCoverage, 'lane-manifest.json'))).toBe(false);
      expect(existsSync(join(failedCoverage, 'executed-files.txt'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test.each(['empty', 'populated'])('refuses an existing %s coverage destination without changing its files', kind => {
    const root = setup();
    try {
      const coverage = join(root, 'coverage');
      mkdirSync(coverage);
      const prior: Record<string, string> = kind === 'empty' ? {} : {
        'e2e-1/lcov.info': 'numbered prior result',
        'other/lcov.info': 'unrelated prior result',
        'lane-manifest.json': '{"complete":true,"sha":"prior-commit"}',
        'executed-files.txt': 'prior file receipt',
      };
      for (const [file, contents] of Object.entries(prior)) {
        mkdirSync(join(coverage, file, '..'), { recursive: true });
        writeFileSync(join(coverage, file), contents);
      }
      const result = spawnSync('bash', ['scripts/run-e2e.sh', 'test/e2e/a.test.ts'], {
        cwd: root, encoding: 'utf8', env: { ...env, COVERAGE_DIR: coverage },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must be a new, unused directory');
      expect(result.stdout).not.toContain('=== a.test.ts ===');
      for (const [file, contents] of Object.entries(prior)) expect(readFileSync(join(coverage, file), 'utf8')).toBe(contents);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a fully skipped file has execution evidence but need not emit LCOV', () => {
    const root = setup();
    try {
      writeFileSync(join(root, 'bin/git'), '#!/bin/sh\nprintf fixture-commit\n', { mode: 0o755 });
      writeFileSync(join(root, 'test/e2e/a.test.ts'), "import {test} from 'bun:test'; test.skip('requires optional fixture',()=>{});");
      const result = spawnSync('bash', ['scripts/run-e2e.sh', 'test/e2e/a.test.ts'], {
        cwd: root, encoding: 'utf8', env: { ...env, COVERAGE_DIR: 'coverage', PATH: `${join(root, 'bin')}:${process.env.PATH}` },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(root, 'coverage/lane-manifest.json'), 'utf8'))).toEqual({ lane: 'e2e', sha: 'fixture-commit', lcovCount: 0, complete: true });
      expect(readFileSync(join(root, 'coverage/executed-files.txt'), 'utf8')).toBe('test/e2e/a.test.ts\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('native reports retain nested imported suites, skips and todos within the selected file', () => {
    const root = setup();
    try {
      writeFileSync(join(root, 'test/imported.ts'), `import {describe,test,expect} from 'bun:test';
describe('imported',()=>{
  test('pass',()=>expect(1).toBe(1));
  describe('nested',()=>test.skip('skip',()=>{}));
});
describe('second',()=>test.todo('todo'));`);
      writeFileSync(join(root, 'test/e2e/a.test.ts'), "import '../imported';");
      const result = run(root, ['test/e2e/a.test.ts']);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('1 pass');
      expect(result.stdout).toContain('1 skip');
      expect(result.stdout).toContain('1 todo');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test.each(['early exit', 'nested summary without parent', 'nested summary with parent'])('%s requires the selected Bun process to finish', kind => {
    const root = setup();
    try {
      writeFileSync(join(root, 'bin/git'), '#!/bin/sh\nprintf fixture-commit\n', { mode: 0o755 });
      writeFileSync(join(root, 'test/child.test.ts'), "import {test,expect} from 'bun:test'; test('child',()=>expect(1).toBe(1));");
      writeFileSync(join(root, 'test/e2e/a.test.ts'), `import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
test('parent',()=>{
  if (${kind !== 'early exit'}) {
    const child = spawnSync(process.execPath, ['test', 'test/child.test.ts'], {encoding:'utf8'});
    console.log(child.stdout);
    console.error(child.stderr);
    expect(child.status).toBe(0);
  }
  if (${kind !== 'nested summary with parent'}) process.exit(0);
});`);
      const result = spawnSync('bash', ['scripts/run-e2e.sh', 'test/e2e/a.test.ts'], {
        cwd: root, encoding: 'utf8', env: { ...env, COVERAGE_DIR: 'coverage', PATH: `${join(root, 'bin')}:${process.env.PATH}` },
      });
      const complete = kind === 'nested summary with parent';
      expect(result.status, result.stdout + result.stderr).toBe(complete ? 0 : 1);
      expect(existsSync(join(root, 'coverage/lane-manifest.json'))).toBe(complete);
      expect(existsSync(join(root, 'coverage/executed-files.txt'))).toBe(complete);
      if (!complete) expect(result.stdout).toContain('did not produce a complete native Bun report');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test.each(['missing console summary', 'missing pass count', 'wrong console file', 'wrong report file', 'reported failure', 'missing testcases', 'truncated XML', 'mismatched XML', 'hidden failure', 'wrong suite count'])('%s cannot turn zero exit into completion', kind => {
    const root = setup();
    try {
      const selected = 'test/e2e/a.test.ts';
      const header = kind === 'wrong console file' ? 'test/e2e/other.test.ts' : selected;
      const file = kind === 'wrong report file' ? 'test/e2e/other.test.ts' : selected;
      const failures = kind === 'reported failure' ? 1 : 0;
      const counts = kind === 'missing pass count' ? ' 0 fail\n' : ` ${1 - failures} pass\n ${failures} fail\n`;
      const output = `bun test v1.3.13\n\n${githubActions ? '::group::' : ''}${header}:\n${counts}${kind === 'missing console summary' ? '' : 'Ran 1 test across 1 file. [1.00ms]\n'}`;
      const testcase = kind === 'missing testcases' ? '' : `<testcase name="parent" file="${file}">${failures || kind === 'hidden failure' ? '<failure />' : ''}</testcase>`;
      let xml = `<testsuites tests="1" failures="${failures}" skipped="0">\n  <testsuite file="${file}" tests="${kind === 'wrong suite count' ? 2 : 1}" failures="${failures}" skipped="0">${testcase}</testsuite>\n</testsuites>\n`;
      if (kind === 'truncated XML') xml = xml.slice(0, xml.indexOf('</testsuites>'));
      if (kind === 'mismatched XML') xml = xml.replace('</testcase>', '</broken>');
      writeFileSync(join(root, 'bin/bun'), `#!/bin/sh
for arg do case "$arg" in --reporter-outfile=*) report="\${arg#*=}" ;; esac; done
printf '%s' '${xml}' > "$report"
printf '%s' '${output}'
`, { mode: 0o755 });
      const result = spawnSync('bash', ['scripts/run-e2e.sh', selected], {
        cwd: root, encoding: 'utf8', env: { ...env, COVERAGE_DIR: 'coverage', PATH: `${join(root, 'bin')}:${process.env.PATH}` },
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('did not produce a complete native Bun report');
      expect(existsSync(join(root, 'coverage/lane-manifest.json'))).toBe(false);
      expect(existsSync(join(root, 'coverage/executed-files.txt'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const firstFails of [false, true]) test(`each file has a fresh home after a ${firstFails ? 'failing' : 'passing'} config writer`, () => {
    const root = setup();
    try {
      const homes = join(root, 'homes.jsonl');
      writeFileSync(join(root, 'test/e2e/a.test.ts'), `
        import {test,expect} from 'bun:test';
        import {writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
        import {join} from 'node:path';
        test('write a schema and harness config',()=>{
          expect(process.env.HOME).toBe(process.env.GBRAIN_HOME);
          appendFileSync(${JSON.stringify(homes)},JSON.stringify(process.env.HOME)+'\\n');
          mkdirSync(join(process.env.GBRAIN_HOME!,'.gbrain'),{recursive:true});
          writeFileSync(join(process.env.GBRAIN_HOME!,'.gbrain/config.json'),'"example-schema-override"');
          writeFileSync(join(process.env.HOME!,'harness-config'),'example');
          expect(${JSON.stringify(firstFails)}).toBe(false);
        });
      `);
      writeFileSync(join(root, 'test/e2e/b.test.ts'), `
        import {test,expect} from 'bun:test';
        import {existsSync,appendFileSync} from 'node:fs';
        import {join} from 'node:path';
        test('start without the preceding file configuration',()=>{
          expect(process.env.HOME).toBe(process.env.GBRAIN_HOME);
          appendFileSync(${JSON.stringify(homes)},JSON.stringify(process.env.HOME)+'\\n');
          expect(existsSync(join(process.env.GBRAIN_HOME!,'.gbrain/config.json'))).toBe(false);
          expect(existsSync(join(process.env.HOME!,'harness-config'))).toBe(false);
        });
      `);
      const result = run(root, ['test/e2e/a.test.ts', 'test/e2e/b.test.ts']);
      expect(result.status, result.stderr + result.stdout).toBe(firstFails ? 1 : 0);
      expect(result.stdout).toContain(`Files: 2 total, ${firstFails ? 1 : 2} passed, ${firstFails ? 1 : 0} failed`);
      const selected = readFileSync(homes, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string);
      expect(selected).toHaveLength(2);
      expect(new Set(selected).size).toBe(2);
      for (const home of selected) expect(existsSync(home)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test.each(['SIGTERM', 'SIGINT'] as const)('%s terminates its owned interrupt-resistant child', async signal => {
    const root = setup();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let pid: number | undefined;
    try {
      const fake = join(root, 'bin/bun');
      const coverage = join(root, 'coverage');
      writeFileSync(fake, `#!/usr/bin/env bash\ntrap '' INT TERM\necho $$ > '${join(root, 'child.pid.tmp')}'\nmv '${join(root, 'child.pid.tmp')}' '${join(root, 'child.pid')}'\nwhile true; do sleep 1; done\n`);
      chmodSync(fake, 0o755);
      child = Bun.spawn(['bash', 'scripts/run-e2e.sh', 'test/e2e/a.test.ts'], { cwd: root, env: { ...env, COVERAGE_DIR: coverage, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, stdout: 'ignore', stderr: 'ignore' });
      const deadline = Date.now() + 5000;
      while (!existsSync(join(root, 'child.pid')) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(join(root, 'child.pid'))).toBe(true);
      pid = Number(readFileSync(join(root, 'child.pid'), 'utf8').trim());
      expect(pid).toBeGreaterThan(0);
      const collision = spawnSync('bash', ['scripts/run-e2e.sh', 'test/e2e/a.test.ts'], {
        cwd: root, env: { ...env, COVERAGE_DIR: coverage, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8',
      });
      expect(collision.status).toBe(1);
      expect(collision.stderr).toContain('must be a new, unused directory');
      expect(() => process.kill(pid!, 0)).not.toThrow();
      child.kill(signal);
      expect(await child.exited).toBe(signal === 'SIGINT' ? 130 : 143);
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(existsSync(join(coverage, 'lane-manifest.json'))).toBe(false);
      expect(existsSync(join(coverage, 'executed-files.txt'))).toBe(false);
    } finally {
      child?.kill();
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
});
