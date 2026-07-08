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

console.log(`Desktop package verified: ${requiredFiles.length} required runtime files are present and no build-machine paths leaked.`);
