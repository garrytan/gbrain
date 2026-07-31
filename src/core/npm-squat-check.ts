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
 * paths (typically the output of `which -a gbrain`).
 */
import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type GbrainBinaryKind = 'real' | 'foreign' | 'broken' | 'unknown';

export interface ClassifiedGbrainBinary {
  /** The candidate path as given (PATH entry / symlink). */
  path: string;
  kind: GbrainBinaryKind;
  /** Human-readable evidence for the classification. */
  detail: string;
}

export interface NpmSquatAssessment {
  status: 'ok' | 'warn' | 'skip';
  message: string;
  binaries: ClassifiedGbrainBinary[];
}

/** Repository marker identifying this project's package.json. */
const REAL_REPO_MARKER = 'garrytan/gbrain';

/** The documented install/remediation path, reused in doctor output. */
export const NPM_SQUAT_REMEDIATION =
  `Remove the unrelated package (\`bun remove -g gbrain\` or \`npm uninstall -g gbrain\`) ` +
  `and install/upgrade only via the documented path: \`bun install -g github:${REAL_REPO_MARKER}\` ` +
  `(or \`git clone https://github.com/${REAL_REPO_MARKER}.git && bun install && bun link\`).`;

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
 * Classify one candidate `gbrain` path:
 *  - 'broken'  : symlink that doesn't resolve / unreadable path.
 *  - 'real'    : compiled gbrain binary, or a script whose nearest
 *                package.json is this project's (repo checkout / bun link /
 *                `bun install -g github:garrytan/gbrain`).
 *  - 'foreign' : nearest package.json is named "gbrain" but is NOT this
 *                project — an unrelated registry install.
 *  - 'unknown' : can't tell (no gbrain package.json above the resolved file).
 */
export function classifyGbrainBinary(path: string): ClassifiedGbrainBinary {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
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
    return { path, kind: 'real', detail: `this project's install at ${found.dir}` };
  }
  return {
    path,
    kind: 'foreign',
    detail: `unrelated npm package named "gbrain" at ${found.dir}`,
  };
}

/**
 * Assess candidate paths in PATH precedence order (first entry wins when the
 * shell runs `gbrain`).
 *
 *  - skip : no candidates (gbrain not on PATH — nothing to check).
 *  - warn : the winning entry is broken, or an unrelated npm package shadows
 *           (appears before) the real binary — including when no real binary
 *           is on PATH at all.
 *  - ok   : the winning entry is the real binary (an unrelated install
 *           sitting BEHIND it is noted but not a warn).
 */
export function assessGbrainBinaries(candidates: string[]): NpmSquatAssessment {
  const unique = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return { status: 'skip', message: 'gbrain not found on PATH', binaries: [] };
  }
  const binaries = unique.map(classifyGbrainBinary);
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
    return {
      status: 'warn',
      message:
        `\`gbrain\` on PATH resolves to an unrelated npm package, not this project ` +
        `(${foreign.path} — ${foreign.detail}). gbrain is NOT distributed on npm. ` +
        NPM_SQUAT_REMEDIATION,
      binaries,
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
