import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDesktopRuntimeContract, type DesktopRuntimeContract } from '../src/main/runtime-contract.ts';

const desktopRoot = resolve(import.meta.dir, '..');
const projectRoot = resolve(desktopRoot, '..');
const runtimeRoot = join(desktopRoot, 'build', 'extraResources', 'pmbrain-runtime');
const contract = getDesktopRuntimeContract();
const bunPath = join(runtimeRoot, contract.runtimeExecutableName);
if (!existsSync(join(runtimeRoot, 'task-worker.js')) || statSync(join(runtimeRoot, 'task-worker.js')).size === 0) throw new Error('Sidecar runtime is missing task-worker.js');
if (!existsSync(join(runtimeRoot, 'database-worker.js')) || statSync(join(runtimeRoot, 'database-worker.js')).size === 0) throw new Error('Sidecar runtime is missing database-worker.js');
const schemaPackSource = join(projectRoot, 'src', 'core', 'schema-pack', 'base');
const bundledSchemaPacks = readdirSync(schemaPackSource).filter(name => name.endsWith('.yaml'));
if (!bundledSchemaPacks.includes('gbrain-base-v2.yaml')) {
  throw new Error(`Source schema pack directory is missing gbrain-base-v2.yaml: ${schemaPackSource}`);
}
const missingSchemaPacks = bundledSchemaPacks
  .map(name => join(runtimeRoot, 'base', name))
  .filter(path => !existsSync(path) || statSync(path).size === 0);
if (missingSchemaPacks.length > 0) {
  throw new Error(`Sidecar runtime is missing bundled schema packs:\n- ${missingSchemaPacks.join('\n- ')}`);
}
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
