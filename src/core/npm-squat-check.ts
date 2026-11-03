/**
 * npm-squat-check — classify `gbrain` binaries found on PATH (#505).
 *
 * The npm registry name `gbrain` belongs to an unrelated third-party package;
 * this project is NOT distributed on npm. A reflexive `npm i -g gbrain` /
 * `bun add -g gbrain` therefore installs something that is not this project
 * and can shadow the real binary on PATH.
 *
 * Pure classification helpers (filesystem-only, no network, no shelling out)
 * so `gbrain doctor` can warn with receipts. The caller supplies the candidate
 * paths (typically the output of `which -a gbrain`) and the `gbrain` package
 * directories under the global install roots (`npm root -g`, Bun's global
 * dir), so an unrelated global install is found even when its bin is not on
 * PATH.
 */
import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { Action } from './agent-output.ts';

export type GbrainBinaryKind = 'real' | 'foreign' | 'broken' | 'unknown';

export interface ClassifiedGbrainBinary {
  /** The candidate path as given (PATH entry / symlink). */
  path: string;
  kind: GbrainBinaryKind;
  /** Human-readable evidence for the classification. */
  detail: string;
  /** The package directory behind a 'real' or 'foreign' script install. */
  packageDir?: string;
  /** Found under a global node_modules root rather than through PATH. */
  global?: true;
}

export interface NpmSquatAssessment {
  status: 'ok' | 'warn' | 'skip';
  message: string;
  binaries: ClassifiedGbrainBinary[];
  /** On a warn caused by an unrelated package: remove it, then reinstall when no real gbrain remains on PATH. */
  fix?: Action;
}

export interface AssessGbrainBinariesOptions {
  /** `gbrain` package directories under global install roots, e.g. `<npm root -g>/gbrain`. */
  globalPackages?: string[];
  /** Bun's global install root (`$BUN_INSTALL/install/global`), to remove a package found there with Bun. */
  bunGlobalRoot?: string;
  /** `npm root -g`: only a package under it is removed with npm, which uninstalls from its own prefix alone. */
  npmRoot?: string;
  /** Directory of the running gbrain's code; when it is this project, a real gbrain exists even if PATH shows none. */
  selfDir?: string;
}

export interface ClassifyGbrainBinaryOptions {
  platform?: typeof process.platform;
  realpath?: (path: string) => string;
}

/** Repository marker identifying this project's package.json. */
const REAL_REPO_MARKER = 'garrytan/gbrain';

/** The documented install command (the `latest-stable` release ref). */
const INSTALL_ARGV = ['bun', 'install', '-g', `github:${REAL_REPO_MARKER}#latest-stable`];

/** #218 recovery: a Bun global install can skip the postinstall that applies schema migrations. */
const SCHEMA_RECOVERY_ARGV = ['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'];

/** The documented install/remediation path, reused in doctor output. */
export const NPM_SQUAT_REMEDIATION =
  `Remove the unrelated package (\`bun remove -g gbrain\` or \`npm uninstall -g gbrain\`) ` +
  `and install/upgrade only via the documented path: \`${INSTALL_ARGV.join(' ')}\` ` +
  `(or \`git clone https://github.com/${REAL_REPO_MARKER}.git && bun install && bun link\`). ` +
  `If the schema is then behind (#218), run \`${SCHEMA_RECOVERY_ARGV.join(' ')}\`.`;

/**
 * A `bun build --compile` gbrain binary is a native executable, not a script.
 * Sniff the magic bytes: ELF, Mach-O (thin + fat), PE.
 */
function isNativeExecutable(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) < 4) return false;
    const be = buf.readUInt32BE(0);
    const le = buf.readUInt32LE(0);
    return (
      be === 0x7f454c46 || // ELF
      be === 0xcafebabe || be === 0xcafebabf || // fat Mach-O
      le === 0xfeedface || le === 0xfeedfacf || // Mach-O 32/64
      (buf[0] === 0x4d && buf[1] === 0x5a) // PE ("MZ")
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Walk up from `start` to the nearest parseable package.json. */
function nearestPackageJson(start: string): { dir: string; pkg: Record<string, any> } | null {
  let cur = start;
  for (let depth = 0; depth < 64; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(cur, 'package.json'), 'utf8'));
      if (pkg && typeof pkg === 'object') return { dir: cur, pkg };
    } catch {
      // Missing or unparseable at this level; keep walking.
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * Is this package.json THIS project? Two markers, either suffices:
 *  - repository field pointing at garrytan/gbrain (string or { url }), or
 *  - this repo's known bin shape (`"bin": { "gbrain": "src/cli.ts" }` — a
 *    git checkout / `bun install -g github:...` install carries it verbatim;
 *    a registry-published package ships built JS, not a bare .ts bin).
 */
function isRealGbrainPackage(pkg: Record<string, any>): boolean {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (typeof repo === 'string' && repo.includes(REAL_REPO_MARKER)) return true;
  if (pkg.bin && typeof pkg.bin === 'object' && pkg.bin.gbrain === 'src/cli.ts') return true;
  return false;
}

/**
 * Candidate paths Node can resolve on the current platform. Git Bash emits
 * `/c/.../gbrain` while the Windows filesystem exposes
 * `C:/.../gbrain.exe`, so normalize the drive prefix and honor the native
 * executable suffix before declaring the PATH entry broken.
 */
function executableCandidates(path: string, platform: typeof process.platform): string[] {
  if (platform !== 'win32') return [path];

  const normalized = path.replace(
    /^\/([a-zA-Z])(?=\/)/,
    (_match, drive: string) => `${drive.toUpperCase()}:`,
  );
  const candidates = [normalized];
  const basename = normalized.split(/[\\/]/).at(-1) ?? '';
  if (!basename.includes('.')) candidates.push(`${normalized}.exe`);
  return candidates;
}

/**
 * Classify one candidate `gbrain` path:
 *  - 'broken'  : symlink that doesn't resolve / unreadable path.
 *  - 'real'    : compiled gbrain binary, or a script whose nearest
 *                package.json is this project's (repo checkout / bun link /
 *                `bun install -g github:garrytan/gbrain`).
 *  - 'foreign' : nearest package.json is named "gbrain" but is NOT this
 *                project — an unrelated registry install.
 *  - 'unknown' : can't tell (no gbrain package.json above the resolved file).
 */
export function classifyGbrainBinary(
  path: string,
  opts: ClassifyGbrainBinaryOptions = {},
): ClassifiedGbrainBinary {
  const platform = opts.platform ?? process.platform;
  const resolve = opts.realpath ?? realpathSync;
  let resolved: string | undefined;
  for (const candidate of executableCandidates(path, platform)) {
    try {
      resolved = resolve(candidate);
      break;
    } catch {
      // Try the next platform-specific candidate.
    }
  }
  if (resolved === undefined) {
    return { path, kind: 'broken', detail: 'broken symlink or unreadable path' };
  }
  if (isNativeExecutable(resolved)) {
    return { path, kind: 'real', detail: `compiled gbrain binary at ${resolved}` };
  }
  const found = nearestPackageJson(dirname(resolved));
  if (!found || found.pkg.name !== 'gbrain') {
    return { path, kind: 'unknown', detail: `no gbrain package.json found above ${resolved}` };
  }
  if (isRealGbrainPackage(found.pkg)) {
    return { path, kind: 'real', detail: `this project's install at ${found.dir}`, packageDir: found.dir };
  }
  return {
    path,
    kind: 'foreign',
    detail: `unrelated npm package named "gbrain" at ${found.dir}`,
    packageDir: found.dir,
  };
}

function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Classify a `gbrain` package directory under a global node_modules root.
 * Null when nothing named "gbrain" is installed there.
 */
export function classifyGlobalGbrainPackage(dir: string): ClassifiedGbrainBinary | null {
  let pkg: Record<string, any>;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== 'object' || pkg.name !== 'gbrain') return null;
  const packageDir = canonicalDir(dir);
  if (isRealGbrainPackage(pkg)) {
    return { path: dir, kind: 'real', detail: `this project's global install at ${packageDir}`, packageDir, global: true };
  }
  return {
    path: dir,
    kind: 'foreign',
    detail: `unrelated npm package named "gbrain" installed globally at ${packageDir}`,
    packageDir,
    global: true,
  };
}

function squatFix(foreign: ClassifiedGbrainBinary, realElsewhere: boolean, opts: AssessGbrainBinariesOptions): Action {
  const dir = foreign.packageDir ?? foreign.path;
  const under = (root?: string) => root !== undefined && dir.startsWith(canonicalDir(root) + sep);
  const viaBun = under(opts.bunGlobalRoot) || /[\\/]\.bun[\\/]install[\\/]global[\\/]/.test(dir);
  const remove = viaBun ? ['bun', 'remove', '-g', 'gbrain'] : under(opts.npmRoot) ? ['npm', 'uninstall', '-g', 'gbrain'] : undefined;
  const verify = { argv: ['gbrain', 'doctor', '--only', 'npm_squat', '--json'] };
  const effect = realElsewhere ? 'can take over the gbrain command' : foreign.global ? 'is installed globally' : 'is what runs as gbrain';
  const why = `The npm registry name "gbrain" belongs to an unrelated package (${dir}); this project is not distributed on npm, and that package ${effect}.`;
  if (!remove) {
    return {
      consent: ['persistent_install'], actor: 'user', requires_exclusive: false, verify, docs: 'README.md#install', why,
      user_message: `An unrelated npm package named "gbrain" is installed at ${dir}. It is not GBrain. Remove it with the package manager that installed it (pnpm, yarn, volta or another npm prefix); npm and bun only remove packages from their own global directories.`,
    };
  }
  const reinstall: Action = {
    argv: INSTALL_ARGV, consent: ['persistent_install'], actor: 'agent', requires_exclusive: false, verify,
    why: 'No real gbrain is left on PATH. This installs it from the latest-stable release ref, the only supported source.',
    then: {
      argv: SCHEMA_RECOVERY_ARGV, consent: [], actor: 'agent', requires_exclusive: false,
      verify: { argv: ['gbrain', 'doctor', '--json'] }, docs: 'README.md#install',
      why: 'A Bun global install can skip the postinstall that applies schema migrations (#218). This applies them and exits 0 only when the schema is at head; exit 1 with migrations_pending means run gbrain doctor --json and relay what it reports.',
    },
  };
  return {
    argv: remove,
    consent: ['persistent_install'], actor: 'agent', ask_user: true, requires_exclusive: false, verify, docs: 'README.md#install', why,
    user_message: `An unrelated npm package named "gbrain" is installed at ${dir}. It is not GBrain${realElsewhere ? ' and can take over the gbrain command' : ''}. Should I uninstall it${realElsewhere ? '' : ' and install GBrain from its GitHub release'}?`,
    ...(realElsewhere ? {} : { then: reinstall }),
  };
}

/**
 * Assess candidate paths in PATH precedence order (first entry wins when the
 * shell runs `gbrain`).
 *
 * `opts.globalPackages` adds each unrelated global package that no PATH entry
 * reaches, after the PATH entries; a real global package adds nothing.
 *
 *  - skip : no candidates and no unrelated global package.
 *  - warn : the winning entry is broken, or an unrelated npm package shadows
 *           (appears before) the real binary — including when no real binary
 *           is on PATH at all.
 *  - ok   : the winning entry is the real binary (an unrelated install
 *           sitting BEHIND it is noted but not a warn).
 */
export function assessGbrainBinaries(candidates: string[], opts: AssessGbrainBinariesOptions = {}): NpmSquatAssessment {
  const unique = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];
  const binaries = unique.map((candidate) => classifyGbrainBinary(candidate));
  const reached = new Set(binaries.flatMap((b) => (b.packageDir ? [canonicalDir(b.packageDir)] : [])));
  for (const dir of new Set(opts.globalPackages ?? [])) {
    const pkg = classifyGlobalGbrainPackage(dir);
    if (pkg?.kind !== 'foreign' || reached.has(pkg.packageDir!)) continue;
    reached.add(pkg.packageDir!);
    binaries.push(pkg);
  }
  if (binaries.length === 0) {
    return { status: 'skip', message: 'gbrain not found on PATH', binaries: [] };
  }
  const first = binaries[0]!;
  const realIdx = binaries.findIndex((b) => b.kind === 'real');
  const foreignIdx = binaries.findIndex((b) => b.kind === 'foreign');

  if (first.kind === 'broken') {
    return {
      status: 'warn',
      message:
        `\`gbrain\` on PATH is a broken link (${first.path}). ` +
        `Note: gbrain is NOT distributed on npm — the npm package named "gbrain" is unrelated. ` +
        NPM_SQUAT_REMEDIATION,
      binaries,
    };
  }
  if (foreignIdx !== -1 && (realIdx === -1 || foreignIdx < realIdx)) {
    const foreign = binaries[foreignIdx]!;
    const self = opts.selfDir ? nearestPackageJson(opts.selfDir) : null;
    const realElsewhere = realIdx !== -1
      || binaries.slice(0, foreignIdx).some((b) => b.kind === 'unknown')
      || (self !== null && self.pkg.name === 'gbrain' && isRealGbrainPackage(self.pkg));
    const where = foreign.global
      ? `An unrelated npm package named "gbrain" is installed globally at ${foreign.packageDir}${realElsewhere ? '' : ', and no real gbrain is on PATH'}. `
      : `\`gbrain\` on PATH resolves to an unrelated npm package, not this project (${foreign.path} — ${foreign.detail}). `;
    return {
      status: 'warn',
      message: `${where}gbrain is NOT distributed on npm. ${NPM_SQUAT_REMEDIATION}`,
      binaries,
      fix: squatFix(foreign, realElsewhere, opts),
    };
  }
  if (foreignIdx !== -1) {
    return {
      status: 'ok',
      message:
        `real gbrain wins on PATH (${first.path}), but an unrelated npm package named ` +
        `"gbrain" is also installed (${binaries[foreignIdx]!.path}). Consider removing it: ` +
        `\`bun remove -g gbrain\` / \`npm uninstall -g gbrain\`.`,
      binaries,
    };
  }
  return {
    status: 'ok',
    message:
      first.kind === 'real'
        ? `gbrain on PATH is the real binary (${first.path}).`
        : `no unrelated npm "gbrain" install detected on PATH (${first.path}).`,
    binaries,
  };
}
