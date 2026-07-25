import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import JSZip from 'jszip';
import { getDesktopRuntimeContract } from '../src/main/runtime-contract.ts';

const desktopRoot = resolve(import.meta.dir, '..');
const projectRoot = resolve(desktopRoot, '..');
const outputDirectory = join(desktopRoot, 'build', 'extraResources', 'pmbrain-runtime');
const runtimeContract = getDesktopRuntimeContract();
const runtimeCacheDirectory = join(desktopRoot, 'build', 'runtime-cache');
const runtimeArchivePath = join(runtimeCacheDirectory, basename(new URL(runtimeContract.archiveUrl).pathname));
const runtimeExecutablePath = join(outputDirectory, runtimeContract.runtimeExecutableName);
const RUNTIME_DOWNLOAD_ATTEMPTS = 3;
const RUNTIME_DOWNLOAD_TIMEOUT_MS = 120_000;

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readSha256(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

function assertRuntimeContract(): void {
  if (process.platform !== runtimeContract.platform || process.arch !== runtimeContract.arch) {
    throw new Error(
      `Desktop runtime must be assembled on ${runtimeContract.platform}-${runtimeContract.arch}; current builder is ${process.platform}-${process.arch}.`,
    );
  }
  if (runtimeContract.schemaVersion !== 1) {
    throw new Error('Unsupported PMBrain Desktop runtime contract.');
  }
  for (const [label, value] of [
    ['archiveSha256', runtimeContract.archiveSha256],
    ['executableSha256', runtimeContract.executableSha256],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label} in the Desktop runtime contract.`);
  }
}

async function ensureRuntimeArchive(): Promise<string> {
  await mkdir(runtimeCacheDirectory, { recursive: true });
  if (await readSha256(runtimeArchivePath) === runtimeContract.archiveSha256) return runtimeArchivePath;

  await rm(runtimeArchivePath, { force: true });
  const temporaryPath = `${runtimeArchivePath}.download`;
  let lastError = 'unknown download error';
  for (let attempt = 1; attempt <= RUNTIME_DOWNLOAD_ATTEMPTS; attempt += 1) {
    await rm(temporaryPath, { force: true });
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), RUNTIME_DOWNLOAD_TIMEOUT_MS);
    try {
      console.log(
        `Downloading pinned Bun ${runtimeContract.bunVersion} ${runtimeContract.arch}-${runtimeContract.flavor} runtime `
        + `(attempt ${attempt}/${RUNTIME_DOWNLOAD_ATTEMPTS})...`,
      );
      const response = await fetch(runtimeContract.archiveUrl, {
        headers: { 'User-Agent': 'PMBrain-Desktop-Runtime-Builder' },
        redirect: 'follow',
        signal: abortController.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await Bun.write(temporaryPath, Buffer.from(await response.arrayBuffer()));
      const downloadedSha256 = await readSha256(temporaryPath);
      if (downloadedSha256 !== runtimeContract.archiveSha256) {
        throw new Error(
          `checksum mismatch: expected ${runtimeContract.archiveSha256}, got ${downloadedSha256 ?? 'unreadable'}`,
        );
      }
      await rename(temporaryPath, runtimeArchivePath);
      return runtimeArchivePath;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await rm(temporaryPath, { force: true });
      if (attempt < RUNTIME_DOWNLOAD_ATTEMPTS) {
        console.warn(`Pinned Bun runtime download failed (${lastError}); retrying.`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(
    `Could not download verified Bun runtime after ${RUNTIME_DOWNLOAD_ATTEMPTS} attempts: ${lastError}`,
  );
}

async function extractRuntimeExecutable(archivePath: string): Promise<void> {
  const archive = await JSZip.loadAsync(await readFile(archivePath));
  const entry = archive.file(runtimeContract.archiveEntry);
  if (!entry) throw new Error(`Pinned Bun archive is missing ${runtimeContract.archiveEntry}.`);
  const executable = await entry.async('nodebuffer');
  const executableSha256 = sha256(executable);
  if (executableSha256 !== runtimeContract.executableSha256) {
    throw new Error(
      `Pinned Bun executable checksum mismatch: expected ${runtimeContract.executableSha256}, got ${executableSha256}.`,
    );
  }
  await Bun.write(runtimeExecutablePath, executable);
  if (runtimeContract.platform !== 'win32') await chmod(runtimeExecutablePath, 0o755);

  const identity = Bun.spawnSync([runtimeExecutablePath, '--revision'], {
    cwd: outputDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const revision = identity.stdout.toString().trim();
  if (identity.exitCode !== 0 || revision !== runtimeContract.bunRevision) {
    throw new Error(
      `Pinned Bun identity mismatch: expected ${runtimeContract.bunRevision}, got ${revision || identity.stderr.toString().trim() || `exit ${identity.exitCode}`}.`,
    );
  }
}

const runtimePackages = [
  ['@electric-sql', 'pglite'],
  ['@napi-rs', 'canvas'],
  ['@napi-rs', runtimeContract.nativeCanvasPackage],
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

assertRuntimeContract();
const runtimeArchive = await ensureRuntimeArchive();

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await extractRuntimeExecutable(runtimeArchive);

const build = Bun.spawn([
  runtimeExecutablePath,
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

await Bun.write(
  join(outputDirectory, 'runtime-manifest.json'),
  `${JSON.stringify(runtimeContract, null, 2)}\n`,
);
await mkdir(join(outputDirectory, 'skills'), { recursive: true });
await cp(join(projectRoot, 'package.json'), join(outputDirectory, 'package.json'));
await cp(join(projectRoot, 'recipes'), join(outputDirectory, 'recipes'), {
  recursive: true,
  filter: shouldCopyRecipeEntry,
});
await cp(join(projectRoot, 'skills'), join(outputDirectory, 'skills'), { recursive: true, force: true });
await cp(join(projectRoot, 'templates'), join(outputDirectory, 'templates'), { recursive: true });
await cp(
  join(projectRoot, 'node_modules', 'pdf-parse', 'dist', 'worker', 'pdf.worker.mjs'),
  join(outputDirectory, 'pdf.worker.mjs'),
);
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
