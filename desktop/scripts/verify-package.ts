import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dir, '..');
const unpackedRoot = join(desktopRoot, 'dist', 'win-unpacked');
const runtimeRoot = join(unpackedRoot, 'resources', 'pmbrain-runtime');
const appUpdateConfig = join(unpackedRoot, 'resources', 'app-update.yml');
const distRoot = join(desktopRoot, 'dist');
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as { version: string };
const hasRuntimeHtml = existsSync(runtimeRoot)
  && readdirSync(runtimeRoot).some((name) => /^index-[\w-]+\.html$/.test(name));
const requiredFiles = [
  join(unpackedRoot, 'PMBrain.exe'),
  appUpdateConfig,
  join(distRoot, `PMBrain-Windows-x64-Setup-${desktopPackage.version}.exe`),
  join(distRoot, `PMBrain-Windows-x64-Setup-${desktopPackage.version}.exe.blockmap`),
  join(distRoot, 'latest.yml'),
  join(runtimeRoot, 'bun.exe'),
  join(runtimeRoot, 'pmbrain-sidecar.js'),
  join(runtimeRoot, 'pdf.worker.mjs'),
  join(runtimeRoot, 'package.json'),
  join(runtimeRoot, 'recipes', 'agent-voice.md'),
  join(runtimeRoot, 'templates', 'SOUL.md.template'),
  join(runtimeRoot, 'skills', 'manifest.json'),
  join(runtimeRoot, 'skills', 'RESOLVER.md'),
  join(runtimeRoot, 'skills', '_brain-filing-rules.json'),
  join(runtimeRoot, 'skills', '_brain-filing-rules.md'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'package.json'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'vector', 'index.js'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'pglite.data'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'pglite.wasm'),
  join(runtimeRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'initdb.wasm'),
  join(runtimeRoot, 'node_modules', '@napi-rs', 'canvas', 'package.json'),
  join(runtimeRoot, 'node_modules', '@napi-rs', 'canvas', 'index.js'),
  join(runtimeRoot, 'node_modules', '@napi-rs', 'canvas-win32-x64-msvc', 'package.json'),
  join(runtimeRoot, 'node_modules', '@napi-rs', 'canvas-win32-x64-msvc', 'skia.win32-x64-msvc.node'),
  join(runtimeRoot, 'node_modules', '@dqbd', 'tiktoken', 'package.json'),
  join(runtimeRoot, 'node_modules', 'web-tree-sitter', 'package.json'),
  join(runtimeRoot, 'node_modules', 'libheif-js', 'package.json'),
];

const missing = requiredFiles.filter((path) => !existsSync(path) || statSync(path).size === 0);
if (!hasRuntimeHtml) {
  missing.push(join(runtimeRoot, 'index-*.html'));
}

const latestYml = existsSync(join(distRoot, 'latest.yml'))
  ? readFileSync(join(distRoot, 'latest.yml'), 'utf8')
  : '';
if (!latestYml.includes(`version: ${desktopPackage.version}`)) {
  missing.push(`${join(distRoot, 'latest.yml')}#version:${desktopPackage.version}`);
}
if (!latestYml.includes(`PMBrain-Windows-x64-Setup-${desktopPackage.version}.exe`)) {
  missing.push(`${join(distRoot, 'latest.yml')}#artifact:${desktopPackage.version}`);
}

const updateUrl = 'https://ghproxy.net/https://github.com/zhengyunhui123-dev/PMBrain/releases/latest/download';
const appUpdateYml = existsSync(appUpdateConfig)
  ? readFileSync(appUpdateConfig, 'utf8')
  : '';
if (!appUpdateYml.includes('provider: generic')) {
  missing.push(`${appUpdateConfig}#provider:generic`);
}
if (!appUpdateYml.includes(updateUrl)) {
  missing.push(`${appUpdateConfig}#url:${updateUrl}`);
}

if (missing.length > 0) {
  console.error('Desktop package verification failed. Missing runtime files:');
  for (const path of missing) console.error(`- ${path}`);
  process.exit(1);
}

const rootVersionPath = join(desktopRoot, '..', 'VERSION');
const rootPackagePath = join(desktopRoot, '..', 'package.json');
const runtimePackagePath = join(runtimeRoot, 'package.json');
const bunPath = join(runtimeRoot, 'bun.exe');
const sidecarPath = join(runtimeRoot, 'pmbrain-sidecar.js');
const versionErrors: string[] = [];

function readPackageVersion(path: string, label: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
    versionErrors.push(`${label} does not contain a non-empty string version: ${path}`);
  } catch (error) {
    versionErrors.push(`${label} could not be read: ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
  return undefined;
}

let rootVersion: string | undefined;
try {
  rootVersion = readFileSync(rootVersionPath, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!rootVersion) versionErrors.push(`Root VERSION is empty: ${rootVersionPath}`);
} catch (error) {
  versionErrors.push(`Root VERSION could not be read: ${rootVersionPath} (${error instanceof Error ? error.message : String(error)})`);
}

const rootPackageVersion = readPackageVersion(rootPackagePath, 'Root package.json');
const runtimePackageVersion = readPackageVersion(runtimePackagePath, 'Packaged runtime package.json');
if (rootVersion && rootPackageVersion && rootPackageVersion !== rootVersion) {
  versionErrors.push(`Root version mismatch: VERSION=${rootVersion}, package.json=${rootPackageVersion}`);
}
if (rootVersion && runtimePackageVersion && runtimePackageVersion !== rootVersion) {
  versionErrors.push(`Packaged runtime version mismatch: expected ${rootVersion}, package.json=${runtimePackageVersion}`);
}

const sidecarVersionResult = spawnSync(bunPath, [sidecarPath, '--version'], {
  cwd: runtimeRoot,
  encoding: 'utf8',
  shell: false,
  timeout: 30_000,
  windowsHide: true,
});
const sidecarVersionOutput = `${sidecarVersionResult.stdout ?? ''}\n${sidecarVersionResult.stderr ?? ''}`.trim();
const sidecarVersionMatch = sidecarVersionOutput
  .split(/\r?\n/)
  .map((line) => line.trim().match(/^pmbrain\s+v?([^\s]+)$/i))
  .find((match) => match !== null);
const sidecarReportedVersion = sidecarVersionMatch?.[1];

if (sidecarVersionResult.error) {
  versionErrors.push(`Packaged sidecar --version failed: ${sidecarVersionResult.error.message}`);
} else if (sidecarVersionResult.status !== 0) {
  versionErrors.push(`Packaged sidecar --version exited with code ${sidecarVersionResult.status ?? 'unknown'}`);
} else if (!sidecarReportedVersion) {
  versionErrors.push('Packaged sidecar --version did not report "pmbrain <version>".');
} else if (rootVersion && sidecarReportedVersion !== rootVersion) {
  versionErrors.push(`Packaged sidecar version mismatch: expected ${rootVersion}, reported ${sidecarReportedVersion}`);
}

if (versionErrors.length > 0) {
  console.error('Desktop package verification failed. Version contract mismatch:');
  for (const error of versionErrors) console.error(`- ${error}`);
  process.exit(1);
}

const forbiddenPatterns = [
  'D:\\cursor-claude',
  'D:/cursor-claude',
  'C:\\Users\\zhengyunhui',
  'Users\\zhengyunhui',
];
const skippedExtensions = new Set([
  '.7z', '.bin', '.blockmap', '.dat', '.dll', '.exe', '.jpg', '.node',
  '.pak', '.png', '.wasm',
]);

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

const scanRoots = [
  join(unpackedRoot, 'resources'),
  join(distRoot, 'latest.yml'),
];
const leaked: string[] = [];
for (const root of scanRoots) {
  const files = statSync(root).isDirectory() ? listFiles(root) : [root];
  for (const file of files) {
    if (skippedExtensions.has(extension(file))) continue;
    const content = readFileSync(file, 'utf8');
    for (const pattern of forbiddenPatterns) {
      if (content.includes(pattern)) leaked.push(`${file}: ${pattern}`);
    }
  }
}
if (leaked.length > 0) {
  console.error('Desktop package verification failed. Build-machine paths leaked into package:');
  for (const item of leaked) console.error(`- ${item}`);
  process.exit(1);
}

console.log(`Desktop package verified: ${requiredFiles.length} required runtime files are present, runtime version ${rootVersion} matches, and no build-machine paths leaked.`);
