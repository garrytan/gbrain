/**
 * The one PostgreSQL the keyword-search goldens and generated tables are measured against: PGLite
 * 0.5.16, which is PostgreSQL 18.6 on a C.UTF-8 database. The repository's own PGLite (0.4.3) is a
 * different PostgreSQL, so this installs the exact version into a scratch directory and never reads
 * node_modules. Used by rust/crates/gbrain-store/tests/fixtures/regen-search-goldens.ts and
 * rust/scripts/gen-parser-charclass.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PGLITE_VERSION = '0.5.16';

/** Installs PGLite 0.5.16 once (into $GBRAIN_PGLITE_GOLDEN_DIR or the temp directory) and returns its entry file. */
export function installPglite(): string {
  const scratch = process.env.GBRAIN_PGLITE_GOLDEN_DIR ?? join(tmpdir(), 'gbrain-pglite-golden-' + PGLITE_VERSION);
  const entry = join(scratch, 'node_modules/@electric-sql/pglite/dist/index.js');
  if (!existsSync(entry)) {
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'package.json'), '{"name":"pglite-golden","private":true}\n');
    execFileSync('bun', ['add', `@electric-sql/pglite@${PGLITE_VERSION}`], { cwd: scratch, stdio: 'inherit' });
  }
  const pkg = JSON.parse(readFileSync(join(scratch, 'node_modules/@electric-sql/pglite/package.json'), 'utf8'));
  if (pkg.version !== PGLITE_VERSION) throw new Error(`need PGLite ${PGLITE_VERSION}, found ${pkg.version} in ${scratch}`);
  return entry;
}
