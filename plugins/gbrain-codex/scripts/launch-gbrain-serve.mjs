import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(SCRIPT_PATH), '..');

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathCandidate(candidate) {
  if (!candidate) return null;
  return isAbsolute(candidate) ? candidate : resolve(candidate);
}

function resolveOnPath(binaryName, pathValue) {
  for (const dir of String(pathValue || '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binaryName);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function prependBunBinToPath(pathValue = '', home = '') {
  const existing = String(pathValue || '').split(delimiter).filter(Boolean);
  const candidates = [];
  if (home) candidates.push(join(home, '.bun', 'bin'));

  try {
    const realHome = userInfo().homedir;
    if (realHome) candidates.push(join(realHome, '.bun', 'bin'));
  } catch {
    // Best effort only; PATH fallback still applies below.
  }

  const seen = new Set();
  const bunBins = candidates.filter(entry => {
    if (!entry || seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });

  const deduped = existing.filter(entry => !seen.has(entry));
  return [...bunBins, ...deduped].join(delimiter);
}

export function buildServeArgs(extraArgs = []) {
  return ['serve', ...extraArgs];
}

function gbrainConfigPath(home) {
  return home ? join(home, '.gbrain', 'config.json') : '';
}

export function resolveGbrainHome(env = process.env) {
  const explicit = env.GBRAIN_HOME;
  if (explicit) return explicit;

  const envHome = env.HOME || '';
  if (envHome && existsSync(gbrainConfigPath(envHome))) return envHome;

  try {
    const realHome = userInfo().homedir;
    if (realHome && existsSync(gbrainConfigPath(realHome))) return realHome;
  } catch {
    // Best effort only; gbrain will surface its own config error if absent.
  }

  return undefined;
}

export function resolveGbrainExecutable({
  pluginRoot = PLUGIN_ROOT,
  env = process.env,
} = {}) {
  const pathValue = prependBunBinToPath(env.PATH || '', env.HOME || '');
  const envOverride = resolvePathCandidate(env.GBRAIN_CODEX_BIN);
  if (envOverride) {
    if (!isExecutable(envOverride)) {
      throw new Error(
        `GBRAIN_CODEX_BIN points to a non-executable path: ${envOverride}\n` +
        `The Codex GBrain plugin is an adapter over a local GBrain install. ` +
        `Set GBRAIN_CODEX_BIN to a working gbrain binary, build ./bin/gbrain in this repo, or put gbrain on PATH.`,
      );
    }
    return { command: envOverride, source: 'env', envPath: pathValue };
  }

  const repoCandidate = resolve(pluginRoot, '..', '..', 'bin', 'gbrain');
  if (isExecutable(repoCandidate)) {
    return { command: repoCandidate, source: 'repo', envPath: pathValue };
  }

  const pathCandidate = resolveOnPath('gbrain', pathValue);
  if (pathCandidate) {
    return { command: pathCandidate, source: 'path', envPath: pathValue };
  }

  throw new Error(
    `Could not resolve a local gbrain executable.\n` +
    `The Codex GBrain plugin is an adapter over a local GBrain install.\n` +
    `Tried, in order:\n` +
    `  1. GBRAIN_CODEX_BIN\n` +
    `  2. ${repoCandidate}\n` +
    `  3. gbrain on PATH (with $HOME/.bun/bin prepended)\n` +
    `Fix one of these and try again. Typical local setup is:\n` +
    `  bun install && bun run build && bun link`,
  );
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const resolved = resolveGbrainExecutable({ pluginRoot: PLUGIN_ROOT, env });
  const gbrainHome = resolveGbrainHome(env);
  const child = spawn(resolved.command, buildServeArgs(argv), {
    cwd: process.cwd(),
    env: {
      ...env,
      ...(gbrainHome ? { GBRAIN_HOME: gbrainHome } : {}),
      PATH: resolved.envPath,
    },
    stdio: 'inherit',
  });

  child.on('error', err => {
    process.stderr.write(`[gbrain-codex] failed to launch gbrain: ${err.message}\n`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(err => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
