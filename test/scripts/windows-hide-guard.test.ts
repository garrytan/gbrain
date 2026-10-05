/**
 * #4992: scripts/check-windows-hide.ts keeps every subprocess launch in src/
 * behind src/core/spawn.ts (which defaults windowsHide: true): it fails on a
 * runtime child_process import or a Bun.spawn* call anywhere else, and on an
 * explicit windowsHide: false outside its allowlist.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-windows-hide.ts');
const SEAM = "import * as childProcess from 'node:child_process';\nexport const spawn = childProcess.spawn;\nexport const bunSpawn = Bun.spawn;\n";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(files: Record<string, string>) {
  const tree = mkdtempSync(join(tmpdir(), 'gbrain-windows-hide-'));
  dirs.push(tree);
  for (const [rel, body] of Object.entries({ 'src/core/spawn.ts': SEAM, ...files })) {
    mkdirSync(join(tree, rel, '..'), { recursive: true });
    writeFileSync(join(tree, rel), body);
  }
  const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: tree } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('check-windows-hide.ts', () => {
  test.each([
    ['a named import', "import { spawn } from 'node:child_process';\nspawn('git', [], { detached: true });\n", 'imports child_process directly'],
    ['the bare specifier', "import { execFileSync } from 'child_process';\nexecFileSync('git');\n", 'imports child_process directly'],
    ['a namespace import', "import * as cp from 'node:child_process';\ncp.spawn('git');\n", 'imports child_process directly'],
    ['a value import beside a type', "import { spawn, type ChildProcess } from 'node:child_process';\nexport let c: ChildProcess = spawn('git');\n", 'imports child_process directly'],
    ['a re-export', "export { spawn } from 'node:child_process';\n", 'imports child_process directly'],
    ['a dynamic import', "export async function f() { const { spawn } = await import('child_process'); spawn('git'); }\n", 'loads child_process with import()'],
    ['a require', "export function f() { const { spawnSync } = require('node:child_process'); spawnSync('git'); }\n", 'loads child_process with require()'],
  ])('%s fails with code, location, fix and docs anchor', (_label, body, what) => {
    const r = run({ 'src/commands/hook.ts': body });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL [windows_hide_direct_child_process]: src/commands/hook.ts:`);
    expect(r.out).toContain(what);
    expect(r.out).toContain('Fix: import it from src/core/spawn.ts, which defaults windowsHide: true');
    expect(r.out).toContain('See:  docs/TESTING.md#windows-hidden-console-guard');
  });

  test.each([
    ['Bun.spawn', 'bunSpawn'],
    ['Bun.spawnSync', 'bunSpawnSync'],
  ])('%s fails and names its wrapper', (call, wrapper) => {
    const r = run({ 'src/core/tailscale.ts': `export const p = ${call}(['tailscale', 'status']);\n` });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL [windows_hide_direct_bun_spawn]: src/core/tailscale.ts:1 calls ${call}`);
    expect(r.out).toContain(`Fix: call ${wrapper} from src/core/spawn.ts`);
  });

  test('an explicit windowsHide: false fails outside the allowlist and passes in it', () => {
    const optOut = "import { bunSpawn } from '../spawn.ts';\nexport function open(argv: string[]) { bunSpawn(argv, { windowsHide: false }); }\n";
    const outside = run({ 'src/core/creds/other.ts': optOut });
    expect(outside.code).toBe(1);
    expect(outside.out).toContain('FAIL [windows_hide_opt_out]: src/core/creds/other.ts:2 sets windowsHide: false');
    const listed = run({ 'src/core/creds/redirect.ts': optOut });
    expect(listed.out).toContain('check-windows-hide: ok');
    expect(listed.code).toBe(0);
  });

  test('an allowlisted file that no longer opts out fails as stale', () => {
    const r = run({ 'src/core/creds/redirect.ts': "import { bunSpawn } from '../spawn.ts';\nexport function open(argv: string[]) { bunSpawn(argv); }\n" });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL [windows_hide_stale_allowlist]: src/core/creds/redirect.ts');
  });

  test('the seam itself, seam imports, type-only imports and typeof Bun.spawn pass', () => {
    const r = run({
      'src/core/worker.ts': [
        "import type { SpawnOptions } from 'node:child_process';",
        "import { type ChildProcess as Child } from 'child_process';",
        "import { bunSpawn, spawn } from './spawn.ts';",
        'export function start(cli: string, o: SpawnOptions): Child { return spawn(cli, [], { ...o, detached: true }); }',
        "export function probe(): ReturnType<typeof Bun.spawn> { return bunSpawn(['git'], { windowsHide: true }); }",
        "export const lazy = () => import('./spawn.ts');",
      ].join('\n') + '\n',
    });
    expect(r.out).toContain('check-windows-hide: ok');
    expect(r.code).toBe(0);
  });

  test('the repository passes', () => {
    const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: REPO } });
    expect(`${r.stdout}${r.stderr}`).toContain('check-windows-hide: ok');
    expect(r.status).toBe(0);
  });
});
