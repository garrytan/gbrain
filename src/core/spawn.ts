/**
 * The one module in src/ that launches subprocesses, so that none of them
 * opens a console window on Windows (#4992).
 *
 * On Windows a `detached: true` child has no console (Bun starts it with
 * DETACHED_PROCESS). Every console program such a process launches without
 * `windowsHide` gets a new, visible console window that takes keyboard focus:
 * git, PowerShell, or the CLI re-executing itself. Any gbrain command can run
 * that way (the Stop-hook push, the backup check, the job supervisor, its
 * worker and every job child), so each wrapper here defaults
 * `windowsHide: true`. An explicit `windowsHide: false` is kept, for a launcher
 * that must show a window. The option does nothing on other platforms.
 *
 * The wrappers look up `child_process` and `Bun` at call time, so a test's
 * `spyOn(childProcess, 'spawn')` or `spyOn(Bun, 'spawn')` still sees the call.
 * `scripts/check-windows-hide.ts` (in `bun run verify`) fails on any other
 * runtime use of `child_process` or `Bun.spawn*` in src/.
 */
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';

export type {
  ChildProcess,
  ExecFileException,
  ExecFileSyncOptionsWithStringEncoding,
  SpawnOptions,
} from 'node:child_process';

type Options = { windowsHide?: boolean } | null | undefined;

/** Call a launcher past its overloads; each wrapper keeps the original's type. */
function launch(fn: unknown, ...args: unknown[]): unknown {
  return (fn as (...a: unknown[]) => unknown)(...args);
}

/** `options` with `windowsHide` defaulted to true. */
function hidden(options: unknown): object {
  const given = options as Options;
  return { ...given, windowsHide: given?.windowsHide ?? true };
}

/** Node's `(file, args?, options?)` overloads as `[args, hidden options]`. */
function argsAndOptions(rest: unknown[]): [unknown, object] {
  const [first, second] = rest;
  return Array.isArray(first) || first == null ? [first ?? [], hidden(second)] : [[], hidden(first)];
}

/** A trailing callback, removed from `rest`. */
function takeCallback(rest: unknown[]): unknown[] {
  return typeof rest[rest.length - 1] === 'function' ? [rest.pop()] : [];
}

export const spawn = ((command: string, ...rest: unknown[]) =>
  launch(childProcess.spawn, command, ...argsAndOptions(rest))) as typeof childProcess.spawn;

export const spawnSync = ((command: string, ...rest: unknown[]) =>
  launch(childProcess.spawnSync, command, ...argsAndOptions(rest))) as typeof childProcess.spawnSync;

export const execFileSync = ((file: string, ...rest: unknown[]) =>
  launch(childProcess.execFileSync, file, ...argsAndOptions(rest))) as typeof childProcess.execFileSync;

export const execSync = ((command: string, options?: unknown) =>
  launch(childProcess.execSync, command, hidden(options))) as typeof childProcess.execSync;

export const execFile = ((file: string, ...rest: unknown[]) => {
  const callback = takeCallback(rest);
  return launch(childProcess.execFile, file, ...argsAndOptions(rest), ...callback);
}) as typeof childProcess.execFile;

export const exec = ((command: string, ...rest: unknown[]) => {
  const callback = takeCallback(rest);
  return launch(childProcess.exec, command, hidden(rest[0]), ...callback);
}) as typeof childProcess.exec;

// `promisify(execFile)` / `promisify(exec)` resolve `{ stdout, stderr }`
// through Node's custom promisified forms; keep that shape for the wrappers.
Object.defineProperty(execFile, promisify.custom, {
  value: (file: string, ...rest: unknown[]) =>
    launch(promisify(childProcess.execFile), file, ...argsAndOptions(rest)),
});
Object.defineProperty(exec, promisify.custom, {
  value: (command: string, options?: unknown) =>
    launch(promisify(childProcess.exec), command, hidden(options)),
});

export const bunSpawn = ((first: unknown, options?: unknown) =>
  Array.isArray(first)
    ? launch(Bun.spawn, first, hidden(options))
    : launch(Bun.spawn, hidden(first))) as typeof Bun.spawn;

export const bunSpawnSync = ((first: unknown, options?: unknown) =>
  Array.isArray(first)
    ? launch(Bun.spawnSync, first, hidden(options))
    : launch(Bun.spawnSync, hidden(first))) as typeof Bun.spawnSync;
