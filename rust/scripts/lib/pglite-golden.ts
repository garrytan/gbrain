/**
 * The one PostgreSQL the keyword-search goldens and generated tables are measured against: PGLite
 * 0.5.16, which is PostgreSQL 18.6 on a C.UTF-8 database. The repository's own PGLite (0.4.3) is a
 * different PostgreSQL, so this installs the exact version into a scratch directory and never reads
 * node_modules. Used by rust/crates/gbrain-store/tests/fixtures/regen-search-goldens.ts and
 * rust/scripts/gen-parser-charclass.ts.
 *
 * The install is pinned to the byte: it downloads npm's 0.5.16 tarball, checks it against the
 * integrity hash npm publishes for it (the package has no dependencies, so the tarball is everything
 * installed) and unpacks it. Without $GBRAIN_PGLITE_GOLDEN_DIR each run gets its own new directory,
 * so two runs on one machine never share or reuse a scratch copy.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PGLITE_VERSION = '0.5.16';
/** npm's `dist.integrity` for @electric-sql/pglite@0.5.16 (registry.npmjs.org). */
export const PGLITE_INTEGRITY = 'sha512-Nj8KcIsJL748W408U2N8q4+9IlONdpRIU8MJypIAAINMJ5nqKyqpX7Mgg/5XKkXiAib3AoZGR6hnJFlrlLBrcg==';
const TARBALL = `https://registry.npmjs.org/@electric-sql/pglite/-/pglite-${PGLITE_VERSION}.tgz`;

/** The integrity string (`sha512-<base64>`) of some bytes, in npm's form. */
export function integrityOf(bytes: Uint8Array): string {
  return 'sha512-' + createHash('sha512').update(bytes).digest('base64');
}

/**
 * Installs PGLite 0.5.16 and returns its entry file. The directory is $GBRAIN_PGLITE_GOLDEN_DIR when
 * set (reused only when it holds this exact verified copy), else a new temp directory for this run that is removed when the process exits.
 */
export async function installPglite(): Promise<string> {
  const shared = process.env.GBRAIN_PGLITE_GOLDEN_DIR;
  const scratch = shared || mkdtempSync(join(tmpdir(), `gbrain-pglite-golden-${PGLITE_VERSION}-`));
  // A per-run directory is this run's alone, so it goes when the process exits.
  if (!shared) process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
  const pkgDir = join(scratch, 'node_modules/@electric-sql/pglite');
  const entry = join(pkgDir, 'dist/index.js');
  const marker = join(scratch, 'integrity');
  const verified = existsSync(entry) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === PGLITE_INTEGRITY;
  if (!verified) {
    const res = await fetch(TARBALL);
    if (!res.ok) throw new Error(`could not download ${TARBALL}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const got = integrityOf(bytes);
    if (got !== PGLITE_INTEGRITY) throw new Error(`${TARBALL} has integrity ${got}, expected ${PGLITE_INTEGRITY}`);
    mkdirSync(pkgDir, { recursive: true });
    const tgz = join(scratch, `pglite-${PGLITE_VERSION}.tgz`);
    writeFileSync(tgz, bytes);
    execFileSync('tar', ['-xzf', tgz, '-C', pkgDir, '--strip-components=1'], { stdio: 'inherit' });
    writeFileSync(marker, PGLITE_INTEGRITY + '\n');
  }
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (pkg.version !== PGLITE_VERSION) throw new Error(`need PGLite ${PGLITE_VERSION}, found ${pkg.version} in ${scratch}`);
  return entry;
}
