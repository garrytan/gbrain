/**
 * `gbrain import` from a second process on a Rust brain whose owner is running.
 *
 * The import must go to the owner whole (src/core/rust-engine/owner-ipc/whole-op.ts) and run there, not in the
 * second process. The second process must print the same output and exit with the same code as the same import on a
 * PGLite brain, the owner must end up with the same pages, and the second process must leave no lock and no partial
 * write behind.
 *
 * The owner here is this test process, hosting an in-memory PGLite engine through the owner election (election.ts),
 * as test/rust-owner-ipc.test.ts does: the Rust store itself does not run transactions yet, so an import cannot run
 * on it in any process. The second process is a real Rust engine shell that becomes a client of that owner. The
 * reference run is the same command handler on an in-memory PGLite brain in a third process.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { electOwner, type OwnerRole } from '../src/core/rust-engine/owner-ipc/election.ts';
import { ownerWholeOperations } from '../src/core/rust-engine/owner-ipc/owner-ops.ts';
import { ownerLockPath } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { pageRows } from './helpers/owner-ipc-import-child.ts';

const CHILD = join(import.meta.dir, 'helpers', 'owner-ipc-import-child.ts');
const ARGS = ['--no-embed', '--json'];

interface ChildRun { code: number | null; stdout: string; stderr: string }

function runImportChild(mode: 'client' | 'pglite', home: string, databasePath: string, importDir: string,
  extraEnv: Record<string, string> = {}): Promise<ChildRun> {
  mkdirSync(home, { recursive: true });
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0',
      GBRAIN_SKIP_UPGRADE_CHECK: '1', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, ...extraEnv };
    const child = spawn(process.execPath, [CHILD, mode, databasePath, importDir, ...ARGS], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** The import's JSON document without its run time, with failures in path order (workers may finish in any order). */
function stableJson(stdout: string): unknown {
  const doc = JSON.parse(stdout) as Record<string, unknown>;
  delete doc.duration_s;
  if (Array.isArray(doc.failures)) (doc.failures as Array<{ path: string }>).sort((a, b) => a.path.localeCompare(b.path));
  return doc;
}

/** The command's stderr without the reference brain's schema setup, the client's role marker and timings. */
function stableStderr(stderr: string): string[] {
  return stderr.split('\n')
    .filter(line => line.trim() !== '' && !/Setting up brain schema|migration\(s\) applied|^\s+v\d+: |^owner-ipc-role=/.test(line))
    .map(line => line.replace(/\b\d+ms\b/g, 'Nms'))
    .sort();
}

const page = (title: string, type: string, body: string) => `---\ntitle: ${title}\ntype: ${type}\n---\n${body}\n`;

describe('gbrain import from a second process on a Rust brain whose owner runs', () => {
  // One fresh owner engine per case, so no case sees another's pages.
  const owners: PGLiteEngine[] = [];
  let dir: string | undefined;
  let role: OwnerRole | undefined;

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      owners.push(engine);
    }
  }, 120_000);
  afterAll(async () => { for (const engine of owners) await engine.disconnect(); });

  afterEach(async () => {
    if (role?.role === 'owner') { await role.server.close(); await role.lock.release(); }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined; role = undefined;
  });

  /**
   * Writes `files` under a fresh import directory, makes this process the owner of a fresh brain, runs the import
   * from a second process and on a PGLite brain, and checks that the two agree and that nothing was left behind.
   */
  async function importBoth(owner: PGLiteEngine, files: Record<string, string>, expectedSlugs: string[], expectedCode: number): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-import-'));
    const db = join(dir, 'brain.rust');
    const notes = join(dir, 'notes');
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(notes, rel)), { recursive: true });
      writeFileSync(join(notes, rel), content);
    }
    role = await electOwner(owner, db, { wholeOperations: ownerWholeOperations() });
    expect(role.role).toBe('owner');
    const lockBefore = readFileSync(ownerLockPath(db), 'utf8');
    const storeBefore = readdirSync(db).sort();

    const pagesOut = join(dir, 'reference-pages.json');
    const viaOwner = await runImportChild('client', join(dir, 'home-client'), db, notes);
    const reference = await runImportChild('pglite', join(dir, 'home-pglite'), db, notes, { OWNER_IPC_PAGES_OUT: pagesOut });

    // The second process was a client of the owner, and it did not fall back to running the import itself.
    expect(viaOwner.stderr).toContain('owner-ipc-role=client');
    expect(viaOwner.stderr).not.toContain('fatal:');
    expect(viaOwner.stderr).not.toMatch(/engine_capability_missing|owner_unavailable|store_locked/);
    expect(reference.stderr).not.toContain('fatal:');

    // The same exit code, JSON document and progress output as the PGLite import.
    expect(reference.code).toBe(expectedCode);
    expect(viaOwner.code).toBe(reference.code);
    expect(stableJson(viaOwner.stdout)).toEqual(stableJson(reference.stdout));
    expect(stableStderr(viaOwner.stderr)).toEqual(stableStderr(reference.stderr));

    // The owner holds exactly the pages the PGLite import made: nothing for a refused file, nothing extra.
    const owned = await pageRows(owner);
    expect(owned.map(p => (p as { slug: string }).slug)).toEqual(expectedSlugs);
    expect(owned).toEqual(JSON.parse(readFileSync(pagesOut, 'utf8')));

    // No lock or partial write: this process still owns the brain under the same lock, the store directory holds what
    // it held before, and the owner has no call or connection left from the second process.
    expect(readFileSync(ownerLockPath(db), 'utf8')).toBe(lockBefore);
    expect(readdirSync(db).sort()).toEqual(storeBefore);
    if (role.role === 'owner') {
      const server = role.server;
      for (let i = 0; i < 100 && server.stats().connections !== 0; i++) await Bun.sleep(10);
      expect(server.stats()).toEqual({ active: 0, queued: 0, connections: 0, inflightBytes: 0 });
    }
  }

  test('a clean import runs in the owner, exits 0 and matches a PGLite import', async () => {
    await importBoth(owners[0]!, {
      'alpha.md': page('Alpha', 'note', 'The first page, imported from a second process.'),
      'acme-example.md': page('Acme Example', 'company', 'A company page.'),
      'people/alice-example.md': page('Alice Example', 'person', 'Alice works at [[acme-example]].'),
    }, ['acme-example', 'alpha', 'people/alice-example'], 0);
  }, 180_000);

  test('an import with refused files exits 1 like PGLite and writes only the files that import', async () => {
    await importBoth(owners[1]!, {
      'good.md': page('Good', 'note', 'This page imports.'),
      'bad.md': '---\ntitle: [unclosed\ntype: note\n---\nThe frontmatter does not parse.\n',
      'clash.md': '---\ntitle: Slug clash\nslug: other/place\ntype: note\n---\nThe declared slug is not the path slug.\n',
    }, ['good'], 1);
  }, 180_000);
});
