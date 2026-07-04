import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dir, '..');
const projectRoot = resolve(desktopRoot, '..');
const outputDirectory = join(desktopRoot, 'build', 'extraResources', 'pmbrain-runtime');

const runtimePackages = [
  ['@electric-sql', 'pglite'],
  ['@napi-rs', 'canvas'],
  ['@napi-rs', 'canvas-win32-x64-msvc'],
] as const;

async function copyRuntimePackage(parts: readonly string[]): Promise<void> {
  const source = join(projectRoot, 'node_modules', ...parts);
  const target = join(outputDirectory, 'node_modules', ...parts);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const build = Bun.spawn([
  process.execPath,
  'build',
  join(projectRoot, 'src', 'cli.ts'),
  '--target=bun',
  '--outdir', outputDirectory,
  '--entry-naming', 'pmbrain-sidecar.js',
  '--external', '@electric-sql/pglite',
  '--external', '@electric-sql/pglite/*',
], {
  cwd: projectRoot,
  stdout: 'inherit',
  stderr: 'inherit',
});

if (await build.exited !== 0) {
  throw new Error('PMBrain sidecar bundle failed.');
}

await cp(process.execPath, join(outputDirectory, 'bun.exe'));
await mkdir(join(outputDirectory, 'skills'), { recursive: true });
await cp(
  join(projectRoot, 'skills', '_brain-filing-rules.json'),
  join(outputDirectory, 'skills', '_brain-filing-rules.json'),
);
await cp(
  join(projectRoot, 'skills', '_brain-filing-rules.md'),
  join(outputDirectory, 'skills', '_brain-filing-rules.md'),
);
for (const runtimePackage of runtimePackages) {
  await copyRuntimePackage(runtimePackage);
}

console.log(`PMBrain runtime assembled at ${outputDirectory}`);
