/**
 * The Bun floor of an upgrade target (#5855). A source or package install
 * runs the new release on the host's Bun, and a release whose `engines.bun`
 * floor that Bun does not meet refuses every command but `--version` once it
 * is swapped in. `gbrain upgrade` (and `gbrain self-upgrade`) refuse such a
 * swap and the autopilot channel holds it; this module reads the target's
 * floor per install method and the host's Bun, and words the refusal.
 *
 * Floors: a bun-link clone reads `package.json` at the commit `git fetch`
 * fetched (the SHA the swap then fast-forwards to, so the checked commit is
 * the installed one); a global package reads `package.json` at the ref its
 * `github:` spec names on raw.githubusercontent.com (the default branch when
 * unpinned, which `bun update gbrain` installs). Only the `>=X.Y.Z` shape the
 * release pins is accepted; any other shape is unreadable, and an unreadable
 * floor holds (autopilot) or refuses (manual) rather than guessing.
 *
 * Runtime: the `bun` on PATH (what the swapped-in CLI's shebang and
 * `bun install` use) and the Bun at `process.execPath` (the running daemon's
 * binary, which `bun upgrade` may have replaced in place); the lower decides.
 * No DB; readers return failure values instead of throwing.
 */

import { execFileSync } from './spawn.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../version.ts';
import { BUN_VERSION_RE, bunVersionMeets, compareBunVersions } from './runtime-version.ts';

/** Exit code of a `gbrain upgrade` refused for the Bun floor (sysexits EX_CONFIG). */
export const BUN_FLOOR_EXIT_CODE = 78;
export const BUN_FLOOR_DOCS = 'docs/guides/upgrades-auto-update.md#bun-floor';
export const BUN_FLOOR_FIX = `Fix: bun upgrade, then gbrain upgrade. Docs: ${BUN_FLOOR_DOCS}`;

const PACKAGE_BODY_LIMIT = 256 * 1024;
const FLOOR_RE = /^>= ?(\d{1,4}\.\d{1,4}\.\d{1,4})$/;

/** `engines.bun` (as `X.Y.Z`) and `version` of a raw package.json body. */
export function parseReleasePackage(body: string): { floor: string | null; version: string | null } {
  if (body.length > PACKAGE_BODY_LIMIT) return { floor: null, version: null };
  let pkg: { engines?: { bun?: unknown }; version?: unknown };
  try {
    pkg = JSON.parse(body);
  } catch {
    return { floor: null, version: null };
  }
  const bun = pkg?.engines?.bun;
  const floor = typeof bun === 'string' ? FLOOR_RE.exec(bun)?.[1] ?? null : null;
  const version = typeof pkg?.version === 'string' && /^\d+(\.\d+){2,3}$/.test(pkg.version) ? pkg.version : null;
  return { floor, version };
}

export type TargetFloor =
  | { ok: true; floor: string; version: string | null }
  | { ok: false; failedRead: string; version?: string | null };

function floorFromBody(body: string, read: string): TargetFloor {
  const { floor, version } = parseReleasePackage(body);
  return floor ? { ok: true, floor, version } : { ok: false, failedRead: `${read} has no \`engines.bun\` floor of the form >=X.Y.Z`, version };
}

function git(repoRoot: string, args: string[], timeout = 10_000): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout,
    maxBuffer: PACKAGE_BODY_LIMIT + 1,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/**
 * A bun-link clone's upgrade target: `git fetch`, the fetched upstream SHA,
 * and the floor in `package.json` at that SHA. `sha` is null when the fetch
 * or the upstream lookup failed; the caller fast-forwards to `sha`, never to
 * a later upstream.
 */
export function readBunLinkTarget(repoRoot: string): { sha: string | null; target: TargetFloor } {
  try {
    git(repoRoot, ['fetch', '-q'], 60_000);
  } catch {
    return { sha: null, target: { ok: false, failedRead: '`git fetch` in the source clone failed' } };
  }
  let sha: string;
  try {
    sha = git(repoRoot, ['rev-parse', '--verify', '@{u}^{commit}']).trim();
  } catch {
    return { sha: null, target: { ok: false, failedRead: 'the source clone has no upstream branch to read' } };
  }
  const read = `\`git show ${sha.slice(0, 12)}:package.json\``;
  try {
    return { sha, target: floorFromBody(git(repoRoot, ['show', `${sha}:package.json`]), read) };
  } catch {
    return { sha, target: { ok: false, failedRead: `${read} failed` } };
  }
}

/** The `gbrain` dependency spec of a Bun global install (`<root>/package.json`). */
export function globalGbrainSpec(globalRoot: string): string | null {
  try {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- globalRoot is Bun's own global install dir (resolveBunGlobalRoot)
    const spec = (JSON.parse(readFileSync(join(globalRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> })
      .dependencies?.gbrain;
    return typeof spec === 'string' ? spec.trim() : null;
  } catch {
    return null;
  }
}

const GITHUB_SPEC_RE = /^(?:github:|git\+https:\/\/github\.com\/|git\+ssh:\/\/git@github\.com[:/]|https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#([A-Za-z0-9_./-]+))?$/;

/** raw.githubusercontent.com URL of `package.json` at the ref a GitHub spec installs; null for any other spec. */
export function rawPackageUrlForSpec(spec: string): string | null {
  const m = GITHUB_SPEC_RE.exec(spec);
  if (!m || m[3]?.includes('..')) return null;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3] ?? 'HEAD'}/package.json`;
}

/**
 * A package install's upgrade target: `package.json` at the ref its spec
 * installs (the default branch when unpinned). A null spec (a clawhub
 * install) reads the canonical repository's default branch.
 */
export async function readPackageTarget(spec: string | null): Promise<TargetFloor> {
  const url = rawPackageUrlForSpec(spec ?? 'github:garrytan/gbrain');
  if (!url) return { ok: false, failedRead: `the global install's gbrain spec (${spec}) is not a GitHub spec` };
  const read = `GET ${url}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': `gbrain/${VERSION}` }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false, failedRead: `${read} returned HTTP ${res.status}` };
    return floorFromBody(await res.text(), read);
  } catch {
    return { ok: false, failedRead: `${read} failed (network)` };
  }
}

export interface HostBun {
  /** How messages name it: the PATH lookup or the running binary. */
  label: 'bun on PATH' | 'the running Bun';
  path: string;
  version: string;
}

function bunVersionAt(path: string): string | null {
  try {
    const out = execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return BUN_VERSION_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * The host's Bun as the swapped-in release will meet it: the lower of the
 * `bun` on PATH and the Bun at `process.execPath` (its `Bun.version` when the
 * binary does not answer). null when the `bun` on PATH cannot be run.
 */
export function readHostBun(): HostBun | null {
  const pathBin = typeof Bun === 'undefined' ? null : Bun.which('bun', { PATH: process.env.PATH ?? '' });
  const pathVersion = pathBin ? bunVersionAt(pathBin) : null;
  if (!pathBin || !pathVersion) return null;
  const onPath: HostBun = { label: 'bun on PATH', path: pathBin, version: pathVersion };
  if (typeof Bun === 'undefined' || process.execPath === pathBin) return onPath;
  const execVersion = bunVersionAt(process.execPath) ?? Bun.version;
  if (!BUN_VERSION_RE.test(execVersion)) return onPath;
  const running: HostBun = { label: 'the running Bun', path: process.execPath, version: execVersion };
  return (compareBunVersions(execVersion, pathVersion) ?? 0) < 0 ? running : onPath;
}

export type BunFloorVerdict =
  | { ok: true }
  | { ok: false; kind: 'unmet' | 'unreadable'; message: string; auditReason: string };

/**
 * The gate: ok, or a refusal whose `message` names the target, floor, the
 * Bun found with its path and the fix, and whose `auditReason` is the same
 * text without the local path (the self-upgrade audit records no paths).
 */
export function evaluateBunFloor(target: TargetFloor, host: HostBun | null, targetVersion?: string | null): BunFloorVerdict {
  const version = target.version ?? targetVersion;
  const name = version ? `gbrain ${version}` : 'the target release';
  if (!target.ok) {
    const text = `Could not read the Bun floor of ${name}: ${target.failedRead}. Docs: ${BUN_FLOOR_DOCS}`;
    return { ok: false, kind: 'unreadable', message: text, auditReason: text };
  }
  if (!host) {
    const text = `${name} requires Bun >=${target.floor}; could not run \`bun --version\` on PATH. ${BUN_FLOOR_FIX}`;
    return { ok: false, kind: 'unreadable', message: text, auditReason: text };
  }
  if (bunVersionMeets(host.version, target.floor)) return { ok: true };
  const head = `${name} requires Bun >=${target.floor}; ${host.label}`;
  const tail = ` is ${host.version}. ${BUN_FLOOR_FIX}`;
  return { ok: false, kind: 'unmet', message: `${head} (${host.path})${tail}`, auditReason: `${head}${tail}` };
}
