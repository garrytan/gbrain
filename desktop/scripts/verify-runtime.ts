import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDesktopRuntimeContract, type DesktopRuntimeContract } from '../src/main/runtime-contract.ts';

const desktopRoot = resolve(import.meta.dir, '..');
const projectRoot = resolve(desktopRoot, '..');
const runtimeRoot = join(desktopRoot, 'build', 'extraResources', 'pmbrain-runtime');
const contract = getDesktopRuntimeContract();
const bunPath = join(runtimeRoot, contract.runtimeExecutableName);
const manifest = JSON.parse(readFileSync(join(runtimeRoot, 'runtime-manifest.json'), 'utf8')) as Partial<DesktopRuntimeContract>;

for (const [key, expected] of Object.entries(contract)) {
  if (manifest[key as keyof DesktopRuntimeContract] !== expected) {
    throw new Error(`Runtime manifest mismatch for ${key}`);
  }
}
const checksum = createHash('sha256').update(readFileSync(bunPath)).digest('hex');
if (checksum !== contract.executableSha256) {
  throw new Error(`Runtime checksum mismatch: expected ${contract.executableSha256}, got ${checksum}`);
}
if (contract.platform !== 'win32' && (statSync(bunPath).mode & 0o111) === 0) {
  throw new Error('Runtime executable bit is missing');
}

function run(args: string[], timeout: number): string {
  const result = spawnSync(bunPath, args, {
    cwd: runtimeRoot,
    encoding: 'utf8',
    shell: false,
    timeout,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.error || result.status !== 0) throw new Error(result.error?.message || output || `exit ${result.status}`);
  return output;
}

const revision = run(['--revision'], 30_000);
if (revision !== contract.bunRevision) throw new Error(`Runtime revision mismatch: ${revision}`);
const rootVersion = readFileSync(join(projectRoot, 'VERSION'), 'utf8').replace(/^\uFEFF/, '').trim();
if (!run([join(runtimeRoot, 'pmbrain-sidecar.js'), '--version'], 30_000).match(new RegExp(`^pmbrain\\s+v?${rootVersion.replace(/\./g, '\\.')}$`, 'm'))) {
  throw new Error('Sidecar version smoke check failed');
}

const smoke = run(['--eval', [
  "const { createCanvas } = await import('@napi-rs/canvas');",
  "if (createCanvas(1, 1).width !== 1) throw new Error('canvas');",
  "const { PGlite } = await import('@electric-sql/pglite');",
  'const db = new PGlite();',
  "await db.query('select 1');",
  'await db.close();',
  "console.log('runtime-smoke-ok');",
].join(' ')], 60_000);
if (!smoke.includes('runtime-smoke-ok')) throw new Error('Canvas/PGLite runtime smoke check failed');

console.log(`Desktop runtime verified for ${contract.platform}-${contract.arch}: Bun, sidecar, Canvas, and PGLite passed.`);
