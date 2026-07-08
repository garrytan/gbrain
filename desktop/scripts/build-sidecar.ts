import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dir, '..');
const projectRoot = resolve(desktopRoot, '..');
const outputDirectory = join(desktopRoot, 'build', 'extraResources', 'pmbrain-runtime');

const runtimePackages = [
  ['@electric-sql', 'pglite'],
  ['@napi-rs', 'canvas'],
  ['@napi-rs', 'canvas-win32-x64-msvc'],
  ['@dqbd', 'tiktoken'],
  ['@aws-sdk'],
  ['@smithy'],
  ['libheif-js'],
  ['tslib'],
  ['web-tree-sitter'],
] as const;

async function copyRuntimePackage(parts: readonly string[]): Promise<void> {
  const source = join(projectRoot, 'node_modules', ...parts);
  const target = join(outputDirectory, 'node_modules', ...parts);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

function shouldCopyRecipeEntry(source: string): boolean {
  const relative = source.slice(join(projectRoot, 'recipes').length).replace(/\\/g, '/');
  const parts = relative.split('/').filter(Boolean);
  if (parts.includes('tests') || parts.includes('__tests__')) return false;
  const name = parts.at(-1) ?? '';
  return !/[._-](test|spec)\.[cm]?[jt]s$/.test(name);
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
  '--external', '@dqbd/tiktoken',
  '--external', '@dqbd/tiktoken/*',
  '--external', '@aws-sdk/util-user-agent-node',
  '--external', '@aws-sdk/util-user-agent-node/*',
  '--external', 'libheif-js',
  '--external', 'libheif-js/*',
  '--external', 'web-tree-sitter',
  '--external', 'web-tree-sitter/*',
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
await cp(join(projectRoot, 'package.json'), join(outputDirectory, 'package.json'));
await cp(join(projectRoot, 'recipes'), join(outputDirectory, 'recipes'), {
  recursive: true,
  filter: shouldCopyRecipeEntry,
});
await cp(join(projectRoot, 'skills'), join(outputDirectory, 'skills'), { recursive: true, force: true });
await cp(join(projectRoot, 'templates'), join(outputDirectory, 'templates'), { recursive: true });
await cp(
  join(projectRoot, 'skills', '_brain-filing-rules.json'),
  join(outputDirectory, 'skills', '_brain-filing-rules.json'),
);
await cp(
  join(projectRoot, 'skills', '_brain-filing-rules.md'),
  join(outputDirectory, 'skills', '_brain-filing-rules.md'),
);
await cp(
  join(projectRoot, 'skills', 'RESOLVER.md'),
  join(outputDirectory, 'skills', 'RESOLVER.md'),
);
for (const runtimePackage of runtimePackages) {
  await copyRuntimePackage(runtimePackage);
}

console.log(`PMBrain runtime assembled at ${outputDirectory}`);
