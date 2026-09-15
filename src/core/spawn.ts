/**
 * The one subprocess seam for src/ (#4992): `child_process` + `Bun.spawn`
 * re-exported with `windowsHide: true` merged into every options object.
 *
 * Why a seam and not a flag at the detached spawn sites: on Windows a
 * detached child runs with DETACHED_PROCESS, i.e. with NO console, and
 * CREATE_NO_WINDOW is ignored for it. Every console-subsystem grandchild that
 * child then spawns (git, powershell, the CLI re-exec'ing itself) gets a
 * brand-new console window unless IT carries CREATE_NO_WINDOW. Any gbrain
 * command can run as a detached child (Stop-hook `sources push`, `backup
 * check`, the supervisor → worker → job-child tree runs every handler), so the
 * flag has to ride on every spawn — hence one module every call site imports.
 * `windowsHide` is a documented no-op on every other platform.
 *
 * Import `spawn`/`exec`/... from here exactly as you would from
 * `node:child_process`; the handle and option TYPES (`ChildProcess`,
 * `SpawnOptions`, ...) are re-exported type-only. A caller that must show a
 * window passes `windowsHide: false` explicitly — the merge keeps it.
 * `test/spawn-windows-hide-guard.test.ts` fails on any `child_process` /
 * `Bun.spawn` use in src/ outside this file.
 */

import * as cp from 'child_process';
import { promisify } from 'node:util';

// Type-only re-exports: they vanish at compile time. A namespace re-export
// (`export * from 'child_process'`) is NOT safe here — `bun build --compile`
// emits a `__reExport(..., child_process)` against an undefined binding for a
// node builtin, and the compiled binary dies at load with
// "ReferenceError: child_process is not defined" (caught by
// scripts/check-pglite-embedded.sh). Values other than the wrapped six below
// are deliberately not re-exported: add a wrapped export if a call site needs
// one, so the windowsHide merge stays universal.
export type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnOptionsWithoutStdio,
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
  ExecOptions,
  ExecException,
  ExecSyncOptions,
  ExecSyncOptionsWithStringEncoding,
  ExecFileOptions,
  ExecFileException,
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithStringEncoding,
  StdioOptions,
  IOType,
} from 'child_process';

/**
 * Return `args` (the argument list of one child_process call, command first)
 * with `windowsHide: true` merged into its options object. The options slot
 * is positional and optional in every signature, so: merge into the first
 * plain-object argument; otherwise fill the first `undefined` slot or insert
 * before the trailing callback; otherwise append. Never mutates the input.
 */
export function withWindowsHide(args: readonly unknown[]): unknown[] {
  const out = [...args];
  for (let i = 1; i < out.length; i++) {
    const a = out[i];
    if (a !== null && typeof a === 'object' && !Array.isArray(a)) {
      const o = a as { windowsHide?: boolean };
      out[i] = { ...o, windowsHide: o.windowsHide ?? true };
      return out;
    }
  }
  const opts = { windowsHide: true };
  for (let i = 1; i < out.length; i++) {
    if (out[i] == null) { out[i] = opts; return out; }
    if (typeof out[i] === 'function') { out.splice(i, 0, opts); return out; }
  }
  out.push(opts);
  return out;
}

type AnyFn = (...args: unknown[]) => unknown;
type Wrapped = 'spawn' | 'spawnSync' | 'exec' | 'execSync' | 'execFile' | 'execFileSync';

// Looked up on the namespace at CALL time (not destructured at import) so a
// test's `spyOn(childProcess, 'spawnSync')` still intercepts through the seam.
// node's exec/execFile carry a `util.promisify.custom` that resolves to
// `{ stdout, stderr }`; the wrapper keeps it (merged through the seam) so
// `promisify(exec)` matches node instead of resolving a bare stdout string.
function hidden<K extends Wrapped>(name: K): (typeof cp)[K] {
  const fn = (...args: unknown[]) => (cp[name] as unknown as AnyFn)(...withWindowsHide(args));
  const custom = (cp[name] as unknown as Record<symbol, AnyFn | undefined>)[promisify.custom];
  if (custom) (fn as unknown as Record<symbol, AnyFn>)[promisify.custom] = (...args: unknown[]) => custom(...withWindowsHide(args));
  return fn as unknown as (typeof cp)[K];
}

export const spawn = hidden('spawn');
export const spawnSync = hidden('spawnSync');
export const exec = hidden('exec');
export const execSync = hidden('execSync');
export const execFile = hidden('execFile');
export const execFileSync = hidden('execFileSync');

type BunSpawnOpts = Record<string, unknown> & { cmd?: string[] };
const hideBun = (cmd: unknown, opts: BunSpawnOpts | undefined): unknown[] =>
  Array.isArray(cmd) ? [cmd, { windowsHide: true, ...opts }] : [{ windowsHide: true, ...(cmd as BunSpawnOpts) }];

/** `Bun.spawn` with `windowsHide: true` merged; both call shapes supported. */
export const bunSpawn: typeof Bun.spawn = ((cmd: unknown, opts?: BunSpawnOpts) =>
  (Bun.spawn as unknown as AnyFn)(...hideBun(cmd, opts))) as unknown as typeof Bun.spawn;

/** `Bun.spawnSync` with `windowsHide: true` merged; both call shapes supported. */
export const bunSpawnSync: typeof Bun.spawnSync = ((cmd: unknown, opts?: BunSpawnOpts) =>
  (Bun.spawnSync as unknown as AnyFn)(...hideBun(cmd, opts))) as unknown as typeof Bun.spawnSync;
