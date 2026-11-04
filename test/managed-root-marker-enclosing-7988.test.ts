/**
 * #7988: activation marked the Git repository that merely encloses a non-Git root (a connector clone or a gbrain-owned
 * content directory under a dotfiles \$HOME) as managed, by writing \`<home>/.git/gbrain-managed.json\`; every legacy
 * writer anywhere under \$HOME then refused \`writer_coordinator_required\`, and the autopilot HEAD probe read the dotfiles
 * HEAD as the root's. A root is marked in its enclosing checkout only when that checkout tracks it (its own \`.git\`, or a
 * committed subdirectory); any other root is marked in its own directory, like the datastore (#7338). A marker an older
 * release wrote is never rewritten: the refusal names the deactivate preview, and deactivation removes it.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readCheckoutHead } from '../src/core/checkout-head.ts';
import { readGitPendingEvidence } from '../src/core/sync-pending.ts';
import { assertLegacyFilesystemWriter, isManagedFilesystemPath, refreshManagedFilesystemRoots } from '../src/core/persistence/filesystem-guard.ts';
import { recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { deactivatePersistence } from '../src/core/persistence/deactivation.ts';
import { readPersistenceBrain } from '../src/core/persistence/managed-mode.ts';
import { settleManagedGitEffects, managedBrain } from './helpers/managed-brain.ts';
import { withEnv } from './helpers/with-env.ts';

const backends: Array<string | undefined> = [undefined, ...(process.env.DATABASE_URL ? [process.env.DATABASE_URL] : [])];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commitAll(root: string): void {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'dotfiles');
}
/** A dotfiles-style home beside the brain's content root: a Git repository tracking one dotfile and ignoring `.gbrain/`. */
function dotfilesHome(root: string): string {
  const home = join(dirname(root), 'user-home');
  mkdirSync(home, { recursive: true });
  git(home, 'init', '-q');
  writeFileSync(join(home, '.bashrc'), 'export EDITOR=vi\n');
  writeFileSync(join(home, '.gitignore'), '.gbrain/\n');
  commitAll(home);
  return home;
}

describe.each(backends.map(url => [url ? 'postgres' : 'pglite', url] as const))('managed roots under a Git home (%s)', (_name, url) => {
  test('a connector clone under a Git home is marked in its own directory, never in the home repository', () => managedBrain(async ({ engine, root }) => {
    const home = join(dirname(root), 'user-home'), connector = join(home, '.gbrain', 'clones', 'source-a-google');
    await refreshManagedFilesystemRoots(engine);
    expect(existsSync(join(home, '.git', 'gbrain-managed.json'))).toBe(false);
    expect(existsSync(join(connector, '.gbrain-managed'))).toBe(true);
    expect(isManagedFilesystemPath(join(home, '.gbrain', 'skillpack-bridge-state.json'))).toBe(false);
    expect(isManagedFilesystemPath(join(home, 'notes', 'todo.md'))).toBe(false);
    await assertLegacyFilesystemWriter(engine, join(home, '.gbrain', 'skillpack-bridge-state.json'));
    await expect(assertLegacyFilesystemWriter(engine, join(connector, 'mail.md'))).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    await expect(assertLegacyFilesystemWriter(engine, join(root, 'note.md'))).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    expect(await readCheckoutHead(connector)).toBeNull();
  }, { databaseUrl: url, setup: async ({ engine, root }) => {
    const connector = join(dotfilesHome(root), '.gbrain', 'clones', 'source-a-google');
    mkdirSync(connector, { recursive: true });
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('source-a','source-a',$1,'{\"kind\":\"google\"}')", [connector]);
  } }), 180_000);

  test('a marker an older release wrote in the enclosing repository is kept, named in the refusal, and removed by deactivation', () => managedBrain(async ({ engine, root }) => {
    const home = join(dirname(root), 'user-home'), marker = join(home, '.git', 'gbrain-managed.json');
    const brain = await readPersistenceBrain(engine);
    writeFileSync(marker, JSON.stringify({ version: 1, managed: true, brain_id: brain.brain_id, mode_epoch: Number(brain.mode_epoch) }));
    await refreshManagedFilesystemRoots(engine);
    expect(existsSync(marker)).toBe(true);
    await expect(assertLegacyFilesystemWriter(engine, join(home, '.gbrain', 'skillpack-bridge-state.json'))).rejects.toMatchObject({
      code: 'writer_coordinator_required', suggestion: expect.stringContaining('gbrain sources writer deactivate --dry-run --json') });
    await settleManagedGitEffects(engine);
    expect(await deactivatePersistence(engine, { requestId: randomUUID() })).toMatchObject({ mode: 'classic', deactivated: true });
    expect(existsSync(marker)).toBe(false);
    expect(isManagedFilesystemPath(join(home, '.gbrain', 'skillpack-bridge-state.json'))).toBe(false);
  }, { databaseUrl: url, setup: async ({ engine, root }) => {
    const connector = join(dotfilesHome(root), '.gbrain', 'clones', 'source-a-google');
    mkdirSync(connector, { recursive: true });
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('source-a','source-a',$1,'{\"kind\":\"google\"}')", [connector]);
  } }), 180_000);
});

test('a committed subdirectory of a checkout keeps the enclosing-checkout marker and HEAD', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gbrain-monorepo-7988-'));
  try {
    await withEnv({ GBRAIN_HOME: join(base, 'gbrain-home') }, async () => {
      const repo = join(base, 'repo'), wiki = join(repo, 'wiki');
      mkdirSync(wiki, { recursive: true }); git(repo, 'init', '-q');
      writeFileSync(join(wiki, 'alice-example.md'), '---\ntitle: Alice Example\n---\nNotes.\n');
      commitAll(repo);
      recordManagedRoots(randomUUID(), [{ local_path: wiki, source_id: 'source-b' }]);
      expect(existsSync(join(repo, '.git', 'gbrain-managed.json'))).toBe(true);
      expect(existsSync(join(wiki, '.gbrain-managed'))).toBe(false);
      expect((await readCheckoutHead(wiki))?.head).toBe(git(repo, 'rev-parse', 'HEAD'));
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('the HEAD probe reads no HEAD for a root its enclosing repository does not track', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gbrain-head-7988-'));
  try {
    const home = dotfilesHome(join(base, 'content'));
    const clone = join(home, '.gbrain', 'clones', 'source-a-google');
    mkdirSync(clone, { recursive: true });
    expect(await readCheckoutHead(clone)).toBeNull();
    expect((await readCheckoutHead(home))?.head).toBe(git(home, 'rev-parse', 'HEAD'));
    expect(await readGitPendingEvidence(clone, '0000000000000000000000000000000000000000')).toBeNull();
    expect(await readGitPendingEvidence(home, '0000000000000000000000000000000000000000')).toMatchObject({ head: git(home, 'rev-parse', 'HEAD'), behind: true });
  } finally { rmSync(base, { recursive: true, force: true }); }
});
