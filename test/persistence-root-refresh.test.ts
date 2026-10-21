import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { refreshManagedFilesystemRoots, assertManagedFilesystemWrite } from '../src/core/persistence/filesystem-guard.ts';
import { fixtures, initializeFixtures, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { canonicalFilesystemPath, recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-root-refresh-'));
const config: HarnessConfig = {
  kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 5105, schedules: 0, operations: 0,
  sourceIds: ['root-refresh'], principalIds: [randomUUID()],
};
let engine: PGLiteEngine;

beforeAll(async () => withEnv({ GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home }, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
}), 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('unchanged bound roots retain their durable records without replacement', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const [source] = await fixtures(engine, config);
  await refreshManagedFilesystemRoots(engine);
  const directory = join(home, '.gbrain', 'persistence', 'managed-roots');
  const records = () => readdirSync(directory).filter(file => file.endsWith('.json')).map(file => {
    const path = join(directory, file);
    const stat = statSync(path, { bigint: true });
    return { file, inode: stat.ino, modified: stat.mtimeNs, bytes: readFileSync(path, 'utf8') };
  });
  const before = records();
  expect(before).toHaveLength(1);
  await refreshManagedFilesystemRoots(engine);
  expect(records()).toEqual(before);
  expect(JSON.parse(before[0].bytes)).toMatchObject({ source_id: source.id, worktree_id: source.binding.worktree_id });
  expect(() => assertManagedFilesystemWrite(join(source.root, 'note.md'))).toThrow('managed canonical worktree');
}));

test('unbound and moved source paths remain fenced alongside the original bound root', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const [source] = await fixtures(engine, config);
  const unbound = join(home, 'unbound'); mkdirSync(unbound);
  const moved = join(home, 'moved'); mkdirSync(moved);
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['unbound-refresh', unbound]);
    await tx.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [moved, source.id]);
  });
  await refreshManagedFilesystemRoots(engine);
  for (const root of [source.root, unbound, moved]) {
    expect(() => assertManagedFilesystemWrite(join(root, 'note.md'))).toThrow('managed canonical worktree');
  }
  const records = readdirSync(join(home, '.gbrain', 'persistence', 'managed-roots'));
  expect(records.filter(file => file.endsWith('.json'))).toHaveLength(3);
}));

// Protect alias dedupe and bound metadata against refresh-order overwrites. Existing
// tests use identical path strings; this uses real symlinks and needs no test seam.
test('alias paths retain one root and its bound ownership metadata', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const [source] = await fixtures(engine, config);
  const alias = join(home, 'root-alias'); symlinkSync(source.root, alias);
  // On macOS this also exercises the system /var -> /private/var alias.
  const canonical = canonicalFilesystemPath(source.root);
  const paths = [alias, canonical];
  if (process.platform === 'darwin' && canonical.startsWith('/private/var/')) paths.push(canonical.slice('/private'.length));
  expect(paths.map(canonicalFilesystemPath)).toEqual(paths.map(() => canonical));
  const directory = join(home, '.gbrain', 'persistence', 'managed-roots');
  const bound = { local_path: canonical, source_id: source.id, worktree_id: source.binding.worktree_id };
  for (const rows of [[bound, ...paths.map(local_path => ({ local_path }))], [...paths.map(local_path => ({ local_path })), bound]]) {
    const [{ brain_id }] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    recordManagedRoots(brain_id, rows);
    const matches = readdirSync(directory).map(file => JSON.parse(readFileSync(join(directory, file), 'utf8'))).filter(row => row.root === canonical);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ source_id: source.id, worktree_id: source.binding.worktree_id });
  }
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['alias-refresh', alias]);
  });
  await refreshManagedFilesystemRoots(engine);
  const matches = readdirSync(directory).map(file => JSON.parse(readFileSync(join(directory, file), 'utf8'))).filter(row => row.root === canonical);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ source_id: source.id, worktree_id: source.binding.worktree_id });
}));
