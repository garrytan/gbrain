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
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../config.ts';

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

/** The launcher path for an install whose config dir is `home` (default: this process's). */
export function hookLauncherPath(home: string = configDir()): string {
  return join(home, HOOK_LAUNCHER_DIR, HOOK_LAUNCHER_NAME);
}

export type HookLauncherState = 'current' | 'missing' | 'stale' | 'foreign';

/** Files only. `foreign`: the launcher's directory holds something gbrain did not write, so the launcher refuses to run. */
export function hookLauncherState(path: string): { state: HookLauncherState; detail: string } {
  let names: string[];
  try { names = readdirSync(dirname(path)); } catch { return { state: 'missing', detail: `no hook launcher at ${path}` }; }
  const other = names.find((n) => n !== HOOK_LAUNCHER_NAME);
  if (other !== undefined) return { state: 'foreign', detail: `${dirname(path)} holds ${other}, which gbrain did not write, so the hook launcher refuses to start gbrain there` };
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { state: 'stale', detail: `${path} is not a regular file` };
    if (readFileSync(path, 'utf8') !== HOOK_LAUNCHER_SCRIPT) return { state: 'stale', detail: `${path} differs from the launcher this gbrain writes` };
    if ((st.mode & 0o100) === 0) return { state: 'stale', detail: `${path} is not executable` };
  } catch { return { state: 'missing', detail: `no hook launcher at ${path}` }; }
  return { state: 'current', detail: `hook launcher ${path}` };
}

/**
 * Write (or refresh) the launcher and return its path. Throws when its
 * directory holds anything else: gbrain never deletes a file it did not write,
 * and a hook routed through that directory would refuse anyway.
 */
export function ensureHookLauncher(path: string = hookLauncherPath()): string {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const other = readdirSync(dir).find((n) => n !== HOOK_LAUNCHER_NAME);
  if (other !== undefined) throw new Error(`${dir} holds ${other}, which gbrain did not write; the hook launcher runs gbrain from that directory, so remove it, then run this again`);
  if (hookLauncherState(path).state === 'current') return path;
  // The temp file sits beside the directory, never in it: a hook running meanwhile would refuse to start next to it.
  const tmp = join(dirname(dir), `.${HOOK_LAUNCHER_DIR}.tmp-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, HOOK_LAUNCHER_SCRIPT, { mode: 0o700 });
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

/** An absolute path shaped like a hook launcher (<config dir>/hook-launcher/gbrain-hook). */
export function isHookLauncherPath(path: string): boolean {
  return path.startsWith('/') && path.endsWith(`/${HOOK_LAUNCHER_DIR}/${HOOK_LAUNCHER_NAME}`);
}

/** The launcher a hook command runs gbrain through, or null for a command that starts gbrain in the session directory. */
export function hookLauncherInCommand(command: string): string | null {
  return shellWords(command)?.find(isHookLauncherPath) ?? null;
}

export { HOOK_CWD_ENV, captureHookSessionCwd, hookSessionCwd } from '../session-cwd.ts';
