/**
 * hook-launcher.ts — the trusted-directory launcher that the per-turn hooks
 * `gbrain setup <claude-code|codex>` and the turn-rule lane write run gbrain
 * through (#8424).
 *
 * Why: the script-mode install (`bun install -g`, `bun link`) maps the
 * `gbrain` bin to src/cli.ts, so Bun reads the working directory's
 * bunfig.toml (a top-level `preload` runs before any gbrain code) and its
 * .env files. Harnesses start hooks in the session's directory, so a hook
 * that ran gbrain directly would run a cloned repository's code as the user
 * on every prompt, with nothing for the user to approve.
 *
 * The launcher is a POSIX sh script at <config dir>/hook-launcher/gbrain-hook.
 * It records the session directory in GBRAIN_HOOK_CWD, moves into its own
 * directory and execs its arguments (the absolute gbrain binary and the hook
 * subcommand) there. That directory holds only the launcher: when anything
 * else is in it, the launcher refuses (exit 1, one stderr line) instead of
 * starting Bun next to a file gbrain did not write. `gbrain hook` reads the
 * session directory from GBRAIN_HOOK_CWD where it used process.cwd().
 *
 * The script-mode gbrain starts with `#!/usr/bin/env bun`, and a harness may
 * start the launcher with a PATH that has no bun on it (the Codex desktop app,
 * a GUI launcher), so the launcher of a script-mode install puts the directory
 * of the Bun that wrote it first on PATH (GST-2784). A compiled gbrain needs no
 * Bun, and its launcher stays the plain one.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import { configDir } from '../config.ts';
import { isScriptRuntime } from '../cli-preflight.ts';
import { msysToNativePath } from '../path-confine.ts';

export const HOOK_LAUNCHER_NAME = 'gbrain-hook';
export const HOOK_LAUNCHER_DIR = 'hook-launcher';

export const HOOK_LAUNCHER_SCRIPT = `#!/bin/sh
# gbrain hook launcher v1, written by gbrain setup (#8424); gbrain setup rewrites it.
# Bun reads bunfig.toml and .env from the working directory before gbrain runs,
# so hooks start gbrain from this directory, which holds only this file, and
# pass the session directory on in GBRAIN_HOOK_CWD.
GBRAIN_HOOK_CWD=$PWD
export GBRAIN_HOOK_CWD
case $0 in
  /*/${HOOK_LAUNCHER_NAME}) d=\${0%/*} ;;
  *) echo "gbrain hook launcher: run it by its absolute path, not $0" >&2; exit 1 ;;
esac
cd "$d" || exit 1
for f in * .*; do
  case $f in .|..|${HOOK_LAUNCHER_NAME}) continue ;; esac
  if [ -e "$f" ] || [ -L "$f" ]; then
    echo "gbrain hook launcher: refused: $d holds $f, which gbrain did not write and Bun would read. Remove it, then run: gbrain doctor --only harness_wiring" >&2
    exit 1
  fi
done
exec "$@"
`;

const shellSingleQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const RUNTIME_LINE = /^PATH='((?:[^']|'\\'')*)':\$PATH$/m;

/** The launcher text: the plain one, or for a script-mode install the same with `runtimeDir` (a shell path) put first on PATH before gbrain starts. */
export function hookLauncherScript(runtimeDir: string | null): string {
  if (runtimeDir === null) return HOOK_LAUNCHER_SCRIPT;
  return HOOK_LAUNCHER_SCRIPT.replace('exec "$@"\n', () => `# gbrain runs under the Bun gbrain setup ran under, so a harness started without bun on PATH still starts it.
PATH=${shellSingleQuote(runtimeDir)}:$PATH
export PATH
exec "$@"
`);
}

/** The directory of the Bun this gbrain runs under, as a hook shell path; null for a compiled gbrain, which needs none. */
export function launcherRuntimeDir(): string | null {
  if (!isScriptRuntime()) return null;
  const bun = /^bun(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : Bun.which('bun');
  return bun && isAbsolute(bun) ? hookShellPath(dirname(bun)) : null;
}

const bunIn = (dir: string) => join(msysToNativePath(dir), process.platform === 'win32' ? 'bun.exe' : 'bun');

/** The launcher path for an install whose config dir is `home` (default: this process's). */
export function hookLauncherPath(home: string = configDir()): string {
  return join(home, HOOK_LAUNCHER_DIR, HOOK_LAUNCHER_NAME);
}

export type HookLauncherState = 'current' | 'missing' | 'stale' | 'foreign';

/**
 * Files only. `foreign`: the launcher's directory holds something gbrain did not write, so the launcher refuses to run.
 * `runtimeDir`: the Bun directory this gbrain needs (null for a compiled gbrain); a launcher that names a Bun that is
 * gone, or none when one is needed, is stale.
 */
export function hookLauncherState(path: string, runtimeDir: string | null = launcherRuntimeDir()): { state: HookLauncherState; detail: string } {
  let names: string[];
  try { names = readdirSync(dirname(path)); } catch { return { state: 'missing', detail: `no hook launcher at ${path}` }; }
  const other = names.find((n) => n !== HOOK_LAUNCHER_NAME);
  if (other !== undefined) return { state: 'foreign', detail: `${dirname(path)} holds ${other}, which gbrain did not write, so the hook launcher refuses to start gbrain there` };
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { state: 'stale', detail: `${path} is not a regular file` };
    const text = readFileSync(path, 'utf8');
    const recorded = RUNTIME_LINE.exec(text)?.[1]?.replace(/'\\''/g, "'") ?? null;
    if (text !== hookLauncherScript(recorded)) return { state: 'stale', detail: `${path} differs from the launcher this gbrain writes` };
    if ((st.mode & 0o100) === 0) return { state: 'stale', detail: `${path} is not executable` };
    if (recorded !== null && !existsSync(bunIn(recorded))) return { state: 'stale', detail: `${path} starts gbrain with ${bunIn(recorded)}, which is no longer there, so a harness started without bun on PATH cannot start gbrain` };
    if (recorded === null && runtimeDir !== null) return { state: 'stale', detail: `${path} does not record where bun is, so a harness started without bun on PATH (the Codex app, a GUI launcher) cannot start gbrain` };
  } catch { return { state: 'missing', detail: `no hook launcher at ${path}` }; }
  return { state: 'current', detail: `hook launcher ${path}` };
}

/**
 * Write (or refresh) the launcher and return its path. Throws when its
 * directory holds anything else: gbrain never deletes a file it did not write,
 * and a hook routed through that directory would refuse anyway.
 */
export function ensureHookLauncher(path: string = hookLauncherPath(), runtimeDir: string | null = launcherRuntimeDir()): string {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const other = readdirSync(dir).find((n) => n !== HOOK_LAUNCHER_NAME);
  if (other !== undefined) throw new Error(`${dir} holds ${other}, which gbrain did not write; the hook launcher runs gbrain from that directory, so remove it, then run this again`);
  if (hookLauncherState(path, runtimeDir).state === 'current') return path;
  // The temp file sits beside the directory, never in it: a hook running meanwhile would refuse to start next to it.
  const tmp = join(dirname(dir), `.${HOOK_LAUNCHER_DIR}.tmp-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, hookLauncherScript(runtimeDir), { mode: 0o700 });
    chmodSync(tmp, 0o700);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return path;
}

/**
 * Split a hook command into shell words the way /bin/sh would at its top
 * level: single quotes, double quotes and backslash escapes, so a path the
 * builders quoted (`'/a/o'\''b/x'`) comes back as the path. Null for an
 * unterminated quote.
 */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === ' ' || c === '\t' || c === '\n') { if (word !== null) words.push(word); word = null; continue; }
    word ??= '';
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return null;
      word += command.slice(i + 1, close);
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '\\' && j + 1 < command.length && '$`"\\\n'.includes(command[j + 1]!)) j++;
        word += command[j];
      }
      if (j >= command.length) return null;
      i = j;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
    } else {
      word += c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** An absolute path (POSIX, or on Windows a drive or UNC path) shaped like a hook launcher (<config dir>/hook-launcher/gbrain-hook). */
export function isHookLauncherPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return (path.startsWith('/') || (platform === 'win32' && win32.isAbsolute(path))) && path.replace(/\\/g, '/').endsWith(`/${HOOK_LAUNCHER_DIR}/${HOOK_LAUNCHER_NAME}`);
}

/** A path as a hook command names it: Claude Code runs hooks through Git Bash on Windows, which (like the launcher's own check) wants /c/... for C:\... */
export function hookShellPath(path: string): string {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return drive ? `/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}` : path;
}

/** The launcher a hook command runs gbrain through, as a path this platform's file calls can read, or null for a command that starts gbrain in the session directory. */
export function hookLauncherInCommand(command: string, platform: NodeJS.Platform = process.platform): string | null {
  const launcher = shellWords(command)?.find((word) => isHookLauncherPath(word, platform));
  return launcher ? msysToNativePath(launcher, platform) : null;
}

export { HOOK_CWD_ENV, captureHookSessionCwd, hookSessionCwd } from '../session-cwd.ts';
