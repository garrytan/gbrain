import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDesktopRuntimeContract, type DesktopRuntimeContract } from '../src/main/runtime-contract.ts';

type SupportedPlatform = 'win32' | 'darwin' | 'linux';

const desktopRoot = resolve(import.meta.dir, '..');
const distRoot = join(desktopRoot, 'dist');
const requestedPlatform = process.argv
  .find(argument => argument.startsWith('--platform='))
  ?.slice('--platform='.length) as SupportedPlatform | undefined;
const platform = requestedPlatform ?? process.platform as SupportedPlatform;
const arch = platform === 'darwin' ? 'arm64' : 'x64';
const runtimeContract = getDesktopRuntimeContract(platform, arch);
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as { version: string };

if (process.platform !== platform || process.arch !== arch) {
  throw new Error(`Package verification for ${platform}-${arch} must run on that platform; current runner is ${process.platform}-${process.arch}.`);
}

const shape = platform === 'win32'
  ? {
      unpackedRoot: join(distRoot, 'win-unpacked'),
      runtimeRoot: join(distRoot, 'win-unpacked', 'resources', 'pmbrain-runtime'),
      appUpdateConfig: join(distRoot, 'win-unpacked', 'resources', 'app-update.yml'),
      appExecutable: join(distRoot, 'win-unpacked', 'PMBrain.exe'),
      metadata: join(distRoot, 'latest.yml'),
      artifacts: [
        `PMBrain-Windows-x64-Setup-${desktopPackage.version}.exe`,
        `PMBrain-Windows-x64-Setup-${desktopPackage.version}.exe.blockmap`,
      ],
    }
  : platform === 'darwin'
    ? {
        unpackedRoot: join(distRoot, 'mac-arm64', 'PMBrain.app'),
        runtimeRoot: join(distRoot, 'mac-arm64', 'PMBrain.app', 'Contents', 'Resources', 'pmbrain-runtime'),
        appUpdateConfig: join(distRoot, 'mac-arm64', 'PMBrain.app', 'Contents', 'Resources', 'app-update.yml'),
        appExecutable: join(distRoot, 'mac-arm64', 'PMBrain.app', 'Contents', 'MacOS', 'PMBrain'),
        metadata: join(distRoot, 'latest-mac.yml'),
        artifacts: [
          `PMBrain-macOS-arm64-${desktopPackage.version}.dmg`,
          `PMBrain-macOS-arm64-${desktopPackage.version}.zip`,
          `PMBrain-macOS-arm64-${desktopPackage.version}.zip.blockmap`,
        ],
      }
    : {
        unpackedRoot: join(distRoot, 'linux-unpacked'),
        runtimeRoot: join(distRoot, 'linux-unpacked', 'resources', 'pmbrain-runtime'),
        appUpdateConfig: join(distRoot, 'linux-unpacked', 'resources', 'app-update.yml'),
        appExecutable: join(distRoot, 'linux-unpacked', 'PMBrain'),
        metadata: join(distRoot, 'latest-linux.yml'),
        artifacts: [
          `PMBrain-Linux-x64-${desktopPackage.version}.AppImage`,
          `PMBrain-Linux-x64-${desktopPackage.version}.AppImage.blockmap`,
        ],
      };

const bunPath = join(shape.runtimeRoot, runtimeContract.runtimeExecutableName);
const nativeCanvasRoot = join(shape.runtimeRoot, 'node_modules', '@napi-rs', runtimeContract.nativeCanvasPackage);
const nativeCanvasBinary = join(nativeCanvasRoot, runtimeContract.nativeCanvasBinary);
const runtimeManifestPath = join(shape.runtimeRoot, 'runtime-manifest.json');
const sidecarPath = join(shape.runtimeRoot, 'pmbrain-sidecar.js');
const requiredFiles = [
  shape.appExecutable,
  shape.appUpdateConfig,
  shape.metadata,
  ...shape.artifacts.map(name => join(distRoot, name)),
  bunPath,
  sidecarPath,
  runtimeManifestPath,
  join(shape.runtimeRoot, 'pdf.worker.mjs'),
  join(shape.runtimeRoot, 'package.json'),
  join(shape.runtimeRoot, 'recipes', 'agent-voice.md'),
  join(shape.runtimeRoot, 'templates', 'SOUL.md.template'),
  join(shape.runtimeRoot, 'skills', 'manifest.json'),
  join(shape.runtimeRoot, 'skills', 'RESOLVER.md'),
  join(shape.runtimeRoot, 'skills', '_brain-filing-rules.json'),
  join(shape.runtimeRoot, 'skills', '_brain-filing-rules.md'),
  join(shape.runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'package.json'),
  join(shape.runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js'),
  join(shape.runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'vector', 'index.js'),
  join(shape.runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'pglite.data'),
  join(shape.runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'pglite.wasm'),
  join(shape.runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'initdb.wasm'),
  join(shape.runtimeRoot, 'node_modules', '@napi-rs', 'canvas', 'package.json'),
  join(shape.runtimeRoot, 'node_modules', '@napi-rs', 'canvas', 'index.js'),
  join(nativeCanvasRoot, 'package.json'),
  nativeCanvasBinary,
  join(shape.runtimeRoot, 'node_modules', '@dqbd', 'tiktoken', 'package.json'),
  join(shape.runtimeRoot, 'node_modules', 'web-tree-sitter', 'package.json'),
  join(shape.runtimeRoot, 'node_modules', 'libheif-js', 'package.json'),
];

const missing = requiredFiles.filter(path => !existsSync(path) || statSync(path).size === 0);
const hasRuntimeHtml = existsSync(shape.runtimeRoot)
  && readdirSync(shape.runtimeRoot).some(name => /^index-[\w-]+\.html$/.test(name));
if (!hasRuntimeHtml) missing.push(join(shape.runtimeRoot, 'index-*.html'));
if (missing.length > 0) {
  console.error(`Desktop ${platform} package verification failed. Missing files:`);
  for (const path of missing) console.error(`- ${path}`);
  process.exit(1);
}

const updateUrl = 'https://ghproxy.net/https://github.com/zhengyunhui123-dev/PMBrain/releases/latest/download';
const metadata = readFileSync(shape.metadata, 'utf8');
const appUpdateConfig = readFileSync(shape.appUpdateConfig, 'utf8');
const metadataArtifact = shape.artifacts.find(name => !name.endsWith('.blockmap'))!;
const metadataErrors: string[] = [];
if (!metadata.includes(`version: ${desktopPackage.version}`)) metadataErrors.push(`missing version ${desktopPackage.version}`);
if (!metadata.includes(metadataArtifact)) metadataErrors.push(`missing artifact ${metadataArtifact}`);
if (!appUpdateConfig.includes('provider: generic')) metadataErrors.push('missing generic update provider');
if (!appUpdateConfig.includes(updateUrl)) metadataErrors.push(`missing update URL ${updateUrl}`);
if (metadataErrors.length > 0) {
  throw new Error(`Desktop ${platform} update metadata is invalid: ${metadataErrors.join('; ')}`);
}

const compatibilityErrors: string[] = [];
try {
  const manifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8')) as Partial<DesktopRuntimeContract>;
  for (const [key, expected] of Object.entries(runtimeContract)) {
    if (manifest[key as keyof DesktopRuntimeContract] !== expected) {
      compatibilityErrors.push(`Runtime manifest mismatch for ${key}`);
    }
  }
} catch (error) {
  compatibilityErrors.push(`Runtime manifest could not be read: ${error instanceof Error ? error.message : String(error)}`);
}

const packagedBunSha256 = createHash('sha256').update(readFileSync(bunPath)).digest('hex');
if (packagedBunSha256 !== runtimeContract.executableSha256) {
  compatibilityErrors.push(`Packaged Bun checksum mismatch: expected ${runtimeContract.executableSha256}, got ${packagedBunSha256}`);
}
if (platform !== 'win32' && (statSync(bunPath).mode & 0o111) === 0) {
  compatibilityErrors.push(`Packaged Bun is not executable: ${bunPath}`);
}

function binaryArchitecture(path: string): string {
  const header = readFileSync(path).subarray(0, 64);
  if (header.toString('ascii', 0, 2) === 'MZ') {
    const peOffset = header.readUInt32LE(0x3c);
    const peHeader = readFileSync(path).subarray(peOffset, peOffset + 6);
    const machine = peHeader.readUInt16LE(4);
    return machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `pe-0x${machine.toString(16)}`;
  }
  if (header[0] === 0x7f && header.toString('ascii', 1, 4) === 'ELF') {
    const machine = header.readUInt16LE(18);
    return machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : `elf-0x${machine.toString(16)}`;
  }
  if (header.readUInt32LE(0) === 0xfeedfacf) {
    const cpuType = header.readUInt32LE(4);
    return cpuType === 0x0100000c ? 'arm64' : cpuType === 0x01000007 ? 'x64' : `macho-0x${cpuType.toString(16)}`;
  }
  return 'unknown';
}

for (const path of [shape.appExecutable, bunPath, nativeCanvasBinary]) {
  const actual = binaryArchitecture(path);
  if (actual !== runtimeContract.arch) {
    compatibilityErrors.push(`Binary architecture mismatch: expected ${runtimeContract.arch}, got ${actual}: ${path}`);
  }
}
if (compatibilityErrors.length > 0) {
  throw new Error(`Desktop ${platform} runtime compatibility failed:\n- ${compatibilityErrors.join('\n- ')}`);
}

const rootVersionPath = join(desktopRoot, '..', 'VERSION');
const rootPackagePath = join(desktopRoot, '..', 'package.json');
const runtimePackagePath = join(shape.runtimeRoot, 'package.json');
const rootVersion = readFileSync(rootVersionPath, 'utf8').replace(/^\uFEFF/, '').trim();
const rootPackageVersion = (JSON.parse(readFileSync(rootPackagePath, 'utf8')) as { version: string }).version;
const runtimePackageVersion = (JSON.parse(readFileSync(runtimePackagePath, 'utf8')) as { version: string }).version;
if (!rootVersion || rootPackageVersion !== rootVersion || runtimePackageVersion !== rootVersion) {
  throw new Error(`Runtime version mismatch: VERSION=${rootVersion}, root=${rootPackageVersion}, packaged=${runtimePackageVersion}`);
}

const bunRevisionResult = spawnSync(bunPath, ['--revision'], {
  cwd: shape.runtimeRoot,
  encoding: 'utf8',
  shell: false,
  timeout: 30_000,
  windowsHide: true,
});
const bunRevision = `${bunRevisionResult.stdout ?? ''}`.trim();
if (bunRevisionResult.error || bunRevisionResult.status !== 0 || bunRevision !== runtimeContract.bunRevision) {
  throw new Error(`Packaged Bun revision mismatch: expected ${runtimeContract.bunRevision}, got ${bunRevision || bunRevisionResult.error?.message || `exit ${bunRevisionResult.status}`}`);
}

const sidecarVersionResult = spawnSync(bunPath, [sidecarPath, '--version'], {
  cwd: shape.runtimeRoot,
  encoding: 'utf8',
  shell: false,
  timeout: 30_000,
  windowsHide: true,
});
const sidecarVersionOutput = `${sidecarVersionResult.stdout ?? ''}\n${sidecarVersionResult.stderr ?? ''}`;
const sidecarReportedVersion = sidecarVersionOutput.match(/^pmbrain\s+v?([^\s]+)$/im)?.[1];
if (sidecarVersionResult.error || sidecarVersionResult.status !== 0 || sidecarReportedVersion !== rootVersion) {
  throw new Error(`Packaged sidecar version mismatch: expected ${rootVersion}, got ${sidecarReportedVersion ?? sidecarVersionResult.error?.message ?? `exit ${sidecarVersionResult.status}`}`);
}

const runtimeSmokeScript = [
  "const { createCanvas } = await import('@napi-rs/canvas');",
  "const canvas = createCanvas(1, 1);",
  "if (canvas.width !== 1 || canvas.height !== 1) throw new Error('canvas smoke failed');",
  "const { PGlite } = await import('@electric-sql/pglite');",
  'const db = new PGlite();',
  "await db.query('select 1 as ok');",
  'await db.close();',
  "console.log('runtime-smoke-ok');",
].join(' ');
const runtimeSmokeResult = spawnSync(bunPath, ['--eval', runtimeSmokeScript], {
  cwd: shape.runtimeRoot,
  encoding: 'utf8',
  shell: false,
  timeout: 60_000,
  windowsHide: true,
});
const runtimeSmokeOutput = `${runtimeSmokeResult.stdout ?? ''}\n${runtimeSmokeResult.stderr ?? ''}`.trim();
if (runtimeSmokeResult.error || runtimeSmokeResult.status !== 0 || !runtimeSmokeOutput.includes('runtime-smoke-ok')) {
  throw new Error(`Native Canvas/PGLite runtime smoke failed: ${runtimeSmokeResult.error?.message || runtimeSmokeOutput || `exit ${runtimeSmokeResult.status}`}`);
}

const forbiddenPatterns = ['D:\\cursor-claude', 'D:/cursor-claude', 'C:\\Users\\zhengyunhui', 'Users\\zhengyunhui'];
const skippedExtensions = new Set(['.7z', '.asar', '.bin', '.blockmap', '.dat', '.dll', '.dmg', '.exe', '.jpg', '.node', '.pak', '.png', '.wasm', '.zip']);
function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}
function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
  });
}
const leaked = [...listFiles(join(shape.unpackedRoot, platform === 'darwin' ? 'Contents' : 'resources')), shape.metadata]
  .filter(file => !skippedExtensions.has(extension(file)))
  .flatMap(file => forbiddenPatterns.filter(pattern => readFileSync(file, 'utf8').includes(pattern)).map(pattern => `${file}: ${pattern}`));
if (leaked.length > 0) {
  throw new Error(`Build-machine paths leaked into package:\n- ${leaked.join('\n- ')}`);
}

console.log(
  `Desktop ${platform}-${arch} package verified: ${requiredFiles.length} required files, updater metadata, `
  + `Bun ${runtimeContract.bunRevision}, sidecar ${rootVersion}, Canvas/PGLite smoke, native architecture, and path-leak checks passed.`,
);
