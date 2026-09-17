#!/usr/bin/env bun
/** Rebuild the first-party lock addon with one pinned, cross-platform compiler. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const targets = {
  'linux-x64-glibc': 'x86_64-linux-gnu.2.17',
  'linux-arm64-glibc': 'aarch64-linux-gnu.2.17',
  'linux-x64-musl': 'x86_64-linux-musl',
  'linux-arm64-musl': 'aarch64-linux-musl',
  'darwin-x64': 'x86_64-macos.13.0',
  'darwin-arm64': 'aarch64-macos.13.0',
  'win32-x64': 'x86_64-windows-gnu',
  'win32-arm64': 'aarch64-windows-gnu',
} as const;
export type NativeTarget = keyof typeof targets;
const repo = resolve(import.meta.dir, '../..');
const nativeDir = join(repo, 'native/locks');
export const buildInputs = [
  'native/locks/locks.c', 'native/locks/darwin-abi.h', 'native/locks/abi-check.c',
  'native/locks/windows-napi.h', 'native/locks/windows-ipc.h', 'native/locks/vendor/node-v22.15.0/node_api.h',
  'native/locks/vendor/node-v22.15.0/node_api_types.h',
  'native/locks/vendor/node-v22.15.0/js_native_api.h',
  'native/locks/vendor/node-v22.15.0/js_native_api_types.h',
  'native/locks/vendor/node-v22.15.0/LICENSE',
  'scripts/native/build.ts', 'scripts/native/toolchain.json',
];

export function inputDigest(): string {
  const hash = createHash('sha256');
  for (const file of buildInputs) hash.update(file).update('\0').update(readFileSync(join(repo, file))).update('\0');
  return hash.digest('hex');
}

function build(target: NativeTarget, output: string, zig: string): void {
  mkdirSync(output, { recursive: true });
  const args = ['cc', '-target', targets[target], '-shared', '-fPIC', '-O2', '-s',
    '-DNAPI_VERSION=3', '-DBUILDING_NODE_EXTENSION', `-DGBRAIN_NATIVE_TARGET="${target}"`,
    '-Inative/locks/vendor/node-v22.15.0', '-ffile-prefix-map=.=gbrain',
    'native/locks/locks.c', '-o', join(output, `${target}.node`)];
  if (target.startsWith('darwin-')) args.push('-ffreestanding', '-nostdlib', '-Wl,-undefined,dynamic_lookup', `-Wl,-install_name,@rpath/gbrain-lock-${target}.node`);
  else if (target.startsWith('win32-')) args.push('-lbcrypt');
  else if (!target.startsWith('win32-')) args.push('-Wl,--build-id=none');
  execFileSync(zig, args, { cwd: repo, stdio: 'inherit', env: { ...process.env, SOURCE_DATE_EPOCH: '1745280000' } });
  if (target.startsWith('win32-')) rmSync(join(output, 'locks.lib'), { force: true });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const requested = value('--target') ?? 'all';
  const selected = requested === 'all' ? Object.keys(targets) as NativeTarget[] : [requested as NativeTarget];
  if (selected.some(target => !(target in targets))) throw new Error(`Unknown target: ${requested}`);
  const zig = value('--zig') ?? process.env.ZIG ?? 'zig';
  if (execFileSync(zig, ['version'], { encoding: 'utf8' }).trim() !== '0.14.1') throw new Error('Native builds require Zig 0.14.1');
  const output = resolve(value('--output') ?? join(nativeDir, 'prebuilds'));
  for (const target of selected) { build(target, output, zig); console.log(`Built ${target}`); }
  if (args.includes('--write-manifest')) {
    if (requested !== 'all') throw new Error('--write-manifest requires --target all');
    const artifacts = Object.fromEntries(Object.keys(targets).map(target => {
      const bytes = readFileSync(join(output, `${target}.node`));
      return [target, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }];
    }));
    writeFileSync(join(nativeDir, 'manifest.json'), JSON.stringify({ version: 1, napi: 3, zig: '0.14.1', input_sha256: inputDigest(), artifacts }, null, 2) + '\n');
  }
}
