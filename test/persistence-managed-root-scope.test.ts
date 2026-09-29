import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertManagedFilesystemWrite } from '../src/core/persistence/filesystem-guard.ts';
import { attestLegacyGitMarkerScope, recordManagedRoots, registeredManagedRoots } from '../src/core/persistence/root-registry.ts';
import { withEnv } from './helpers/with-env.ts';

async function fixture(fn: (paths: { home: string; brain: string; connector: string; vault: string; scratch: string }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-scope-'));
  const brain = join(home, 'brain');
  const connector = join(home, 'connectors', 'example');
  const vault = join(home, '.gbrain', 'credentials.json');
  const scratch = join(home, 'scratch', 'note.md');
  mkdirSync(join(home, '.git'));
  mkdirSync(brain);
  mkdirSync(connector, { recursive: true });
  try { await withEnv({ GBRAIN_HOME: home }, () => fn({ home, brain, connector, vault, scratch })); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

test('Git-less managed roots do not stamp enclosing HOME Git metadata or fence unrelated paths', async () => fixture(async ({ home, brain, connector, vault, scratch }) => {
  const brainId = randomUUID();
  recordManagedRoots(brainId, [{ local_path: brain }, { local_path: connector, source_id: 'example' }]);
  expect(existsSync(join(home, '.git', 'gbrain-managed.json'))).toBe(false);
  expect(existsSync(join(brain, '.gbrain-managed'))).toBe(true);
  expect(existsSync(join(connector, '.gbrain-managed'))).toBe(true);
  expect(() => assertManagedFilesystemWrite(vault)).not.toThrow();
  expect(() => assertManagedFilesystemWrite(scratch)).not.toThrow();
  for (const root of [brain, connector]) {
    expect(() => assertManagedFilesystemWrite(join(root, 'note.md'))).toThrow('managed canonical worktree');
  }
  const alias = join(home, 'connector-alias');
  symlinkSync(connector, alias, 'dir');
  expect(() => assertManagedFilesystemWrite(join(alias, 'note.md'))).toThrow('managed canonical worktree');
}));

test('legacy ancestor marker stays broad until an explicit v2 scope is attested', async () => fixture(async ({ home, brain, connector, vault, scratch }) => {
  const brainId = randomUUID();
  const marker = join(home, '.git', 'gbrain-managed.json');
  writeFileSync(marker, JSON.stringify({ version: 1, managed: true, brain_id: brainId }));
  expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
  recordManagedRoots(brainId, [{ local_path: brain }, { local_path: connector, source_id: 'example' }]);
  expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
  writeFileSync(marker, JSON.stringify({ version: 2, managed: true, brain_id: brainId, owner_home: home, scope_roots: [brain, connector] }));
  expect(() => assertManagedFilesystemWrite(vault)).not.toThrow();
  expect(() => assertManagedFilesystemWrite(scratch)).not.toThrow();
  expect(() => assertManagedFilesystemWrite(marker)).toThrow('managed canonical worktree');
  expect(() => assertManagedFilesystemWrite(join(home, '.git', 'config'))).toThrow('managed canonical worktree');
  for (const root of [brain, connector]) {
    expect(() => assertManagedFilesystemWrite(join(root, 'note.md'))).toThrow('managed canonical worktree');
  }
  const alias = join(home, 'legacy-alias');
  symlinkSync(connector, alias, 'dir');
  expect(() => assertManagedFilesystemWrite(join(alias, 'note.md'))).toThrow('managed canonical worktree');
  // The marker itself carries the attested scope; registry updates cannot silently narrow v1.
  expect(existsSync(marker)).toBe(true);
  writeFileSync(marker, '{');
  expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
  writeFileSync(marker, JSON.stringify({ version: 2, managed: true, brain_id: brainId, owner_home: home, scope_roots: [brain, connector] }));
  writeFileSync(join(home, '.gbrain', 'persistence', 'managed-roots', 'broken.json'), '{');
  expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
}));

test('a registered Git root remains fenced with its own marker', async () => fixture(async ({ home, scratch }) => {
  const brainId = randomUUID();
  recordManagedRoots(brainId, [{ local_path: home }]);
  const marker = join(home, '.git', 'gbrain-managed.json');
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({
    version: 2, brain_id: brainId, owner_home: home, scope_roots: [home],
  });
  expect(() => assertManagedFilesystemWrite(scratch)).toThrow('managed canonical worktree');
}));

test('legacy markers fail closed without matching or readable registry evidence', async () => fixture(async ({ home, brain, vault }) => {
  const brainId = randomUUID();
  writeFileSync(join(home, '.git', 'gbrain-managed.json'), JSON.stringify({ version: 1, managed: true, brain_id: brainId }));
  expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
  recordManagedRoots(randomUUID(), [{ local_path: brain }]);
  expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
  writeFileSync(join(home, '.gbrain', 'persistence', 'managed-roots', 'broken.json'), '{');
  expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
}));

test('a second home cannot release another home\'s legacy live or stale roots', async () => fixture(async ({ home, brain, vault }) => {
  const brainId = randomUUID();
  const stale = join(home, 'connectors', 'stale');
  const second = join(home, 'connectors', 'second');
  const otherHome = mkdtempSync(join(tmpdir(), 'gbrain-second-home-'));
  const marker = join(home, '.git', 'gbrain-managed.json');
  mkdirSync(stale, { recursive: true });
  mkdirSync(second, { recursive: true });
  writeFileSync(marker, JSON.stringify({ version: 1, managed: true, brain_id: brainId }));
  // Simulate an older owner: durable records exist, but descendants have no
  // root-local marker and a later refresh omits the stale root.
  const ownerRegistry = join(home, '.gbrain', 'persistence', 'managed-roots');
  mkdirSync(ownerRegistry, { recursive: true });
  for (const root of [brain, stale]) {
    writeFileSync(join(ownerRegistry, `${randomUUID()}.json`), JSON.stringify({ version: 1, brain_id: brainId, root }));
  }
  try {
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(process.env.GBRAIN_HOME).toBe(otherHome);
      recordManagedRoots(brainId, [{ local_path: second }]);
      expect(registeredManagedRoots()).toContain(second);
      expect(existsSync(join(brain, '.gbrain-managed'))).toBe(false);
      expect(existsSync(join(stale, '.gbrain-managed'))).toBe(false);
      expect(() => assertManagedFilesystemWrite(join(brain, 'page.md'))).toThrow('managed canonical worktree');
      expect(() => assertManagedFilesystemWrite(join(stale, 'page.md'))).toThrow('managed canonical worktree');
      expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
    });
    expect(process.env.GBRAIN_HOME).toBe(home);
    writeFileSync(marker, JSON.stringify({ version: 2, managed: true, brain_id: brainId, owner_home: home, scope_roots: [brain, stale] }));
    recordManagedRoots(brainId, [{ local_path: second }]); // Owner refresh, stale roots absent.
    expect(process.env.GBRAIN_HOME).toBe(home);
    expect(registeredManagedRoots()).toContain(second);
    expect(registeredManagedRoots()).toContain(stale);
    expect(existsSync(join(stale, '.gbrain-managed'))).toBe(false);
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(join(brain, 'page.md'))).toThrow('managed canonical worktree');
      expect(() => assertManagedFilesystemWrite(join(stale, 'page.md'))).toThrow('managed canonical worktree');
      expect(() => assertManagedFilesystemWrite(vault)).not.toThrow();
    });
  } finally { rmSync(otherHome, { recursive: true, force: true }); }
}));

test('a second home still refuses a legacy marker without readable owner records', async () => fixture(async ({ home, brain, vault }) => {
  const brainId = randomUUID();
  const second = join(home, 'connectors', 'second');
  const otherHome = mkdtempSync(join(tmpdir(), 'gbrain-second-home-'));
  const marker = join(home, '.git', 'gbrain-managed.json');
  mkdirSync(second, { recursive: true });
  writeFileSync(marker, JSON.stringify({ version: 1, managed: true, brain_id: brainId }));
  try {
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      recordManagedRoots(brainId, [{ local_path: second }]);
      expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
    });
    const ownerRegistry = join(home, '.gbrain', 'persistence', 'managed-roots');
    mkdirSync(ownerRegistry, { recursive: true });
    writeFileSync(join(ownerRegistry, 'broken.json'), '{');
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
    });
    rmSync(join(ownerRegistry, 'broken.json'));
    writeFileSync(join(ownerRegistry, 'owner.json'), JSON.stringify({ version: 1, brain_id: brainId, root: brain }));
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
    });
    writeFileSync(marker, JSON.stringify({ version: 2, managed: true, brain_id: brainId, owner_home: home, scope_roots: [brain] }));
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).not.toThrow();
    });
    writeFileSync(join(ownerRegistry, 'bad.json'), JSON.stringify({ version: 1, brain_id: brainId, root: 'relative' }));
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
    });
    rmSync(join(ownerRegistry, 'bad.json'));
    writeFileSync(join(ownerRegistry, 'bad.json'), JSON.stringify({ version: 1, brain_id: 'not-a-uuid', root: brain }));
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
    });
    rmSync(join(ownerRegistry, 'bad.json'));
    rmSync(marker);
    mkdirSync(marker); // Existing marker path, unreadable as JSON.
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
    });
  } finally { rmSync(otherHome, { recursive: true, force: true }); }
}));

test('a different brain registered at the Git root keeps the ancestor marker broad', async () => fixture(async ({ home, brain, vault }) => {
  const markerBrainId = randomUUID();
  const otherHome = mkdtempSync(join(tmpdir(), 'gbrain-second-home-'));
  writeFileSync(join(home, '.git', 'gbrain-managed.json'), JSON.stringify({ version: 2, managed: true, brain_id: markerBrainId, owner_home: home, scope_roots: [brain, home] }));
  const registry = join(home, '.gbrain', 'persistence', 'managed-roots');
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, 'descendant.json'), JSON.stringify({ version: 1, brain_id: markerBrainId, root: brain }));
  writeFileSync(join(registry, 'ancestor.json'), JSON.stringify({ version: 1, brain_id: randomUUID(), root: home }));
  try {
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
    });
  } finally { rmSync(otherHome, { recursive: true, force: true }); }
}));

test('v2 scope includes stale records for every brain in the marker owner registry', async () => fixture(async ({ home, brain, vault }) => {
  const markerBrainId = randomUUID();
  const secondBrainId = randomUUID();
  const stale = join(home, 'connectors', 'other-brain-stale');
  const otherHome = mkdtempSync(join(tmpdir(), 'gbrain-second-home-'));
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(home, '.git', 'gbrain-managed.json'), JSON.stringify({ version: 2, managed: true, brain_id: markerBrainId, owner_home: home, scope_roots: [brain, stale] }));
  const registry = join(home, '.gbrain', 'persistence', 'managed-roots');
  mkdirSync(registry, { recursive: true });
  for (const [brainId, root] of [[markerBrainId, brain], [secondBrainId, stale]] as const) {
    writeFileSync(join(registry, `${randomUUID()}.json`), JSON.stringify({ version: 1, brain_id: brainId, root }));
  }
  try {
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).not.toThrow();
      expect(() => assertManagedFilesystemWrite(join(brain, 'page.md'))).toThrow('managed canonical worktree');
      expect(() => assertManagedFilesystemWrite(join(stale, 'page.md'))).toThrow('managed canonical worktree');
      const alias = join(home, 'other-brain-alias');
      symlinkSync(stale, alias, 'dir');
      expect(() => assertManagedFilesystemWrite(join(alias, 'page.md'))).toThrow('managed canonical worktree');
    });
  } finally { rmSync(otherHome, { recursive: true, force: true }); }
}));

test('a legacy marker without its owner registry stays broad when its owner uses another home', async () => fixture(async ({ home, brain, vault }) => {
  const brainId = randomUUID();
  const ownerHome = mkdtempSync(join(tmpdir(), 'gbrain-marker-owner-'));
  const otherHome = mkdtempSync(join(tmpdir(), 'gbrain-second-home-'));
  const second = join(home, 'connectors', 'second');
  mkdirSync(second, { recursive: true });
  writeFileSync(join(home, '.git', 'gbrain-managed.json'), JSON.stringify({ version: 1, managed: true, brain_id: brainId }));
  try {
    await withEnv({ GBRAIN_HOME: ownerHome }, () => {
      expect(process.env.GBRAIN_HOME).toBe(ownerHome);
      recordManagedRoots(brainId, [{ local_path: brain }]);
      expect(registeredManagedRoots()).toContain(brain);
    });
    expect(process.env.GBRAIN_HOME).toBe(home);
    rmSync(join(brain, '.gbrain-managed'));
    // A second home colocated with the Git root cannot impersonate the marker
    // owner merely by writing a partial same-brain registry there.
    recordManagedRoots(brainId, [{ local_path: second }]);
    expect(registeredManagedRoots()).toContain(second);
    expect(registeredManagedRoots()).not.toContain(brain);
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
      expect(() => assertManagedFilesystemWrite(join(brain, 'page.md'))).toThrow('managed canonical worktree');
    });
  } finally {
    rmSync(ownerHome, { recursive: true, force: true });
    rmSync(otherHome, { recursive: true, force: true });
  }
}));

test('v2 scopes still fence a linked external Git metadata directory and its .git pointer', async () => fixture(async ({ home, brain, vault }) => {
  const brainId = randomUUID();
  const metadata = mkdtempSync(join(tmpdir(), 'gbrain-external-gitdir-'));
  rmSync(join(home, '.git'), { recursive: true });
  writeFileSync(join(home, '.git'), `gitdir: ${metadata}\n`);
  writeFileSync(join(metadata, 'gbrain-managed.json'), JSON.stringify({
    version: 2, managed: true, brain_id: brainId, owner_home: home, scope_roots: [brain],
  }));
  const registry = join(home, '.gbrain', 'persistence', 'managed-roots');
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, 'brain.json'), JSON.stringify({ version: 1, brain_id: brainId, root: brain }));
  try {
    expect(() => assertManagedFilesystemWrite(vault)).not.toThrow();
    expect(() => assertManagedFilesystemWrite(join(home, '.git'))).toThrow('managed canonical worktree');
    expect(() => assertManagedFilesystemWrite(join(metadata, 'gbrain-managed.json'))).toThrow('managed canonical worktree');
    expect(() => assertManagedFilesystemWrite(join(metadata, 'config'))).toThrow('managed canonical worktree');
  } finally { rmSync(metadata, { recursive: true, force: true }); }
}));

test('operator attestation requires the full stale and mixed-brain registry scope and backs up v1', async () => fixture(async ({ home, brain, vault }) => {
  const brainId = randomUUID();
  const stale = join(home, 'connectors', 'stale');
  const marker = join(home, '.git', 'gbrain-managed.json');
  const otherHome = mkdtempSync(join(tmpdir(), 'gbrain-second-home-'));
  mkdirSync(stale, { recursive: true });
  const v1 = JSON.stringify({ version: 1, managed: true, brain_id: brainId });
  writeFileSync(marker, v1);
  const registry = join(home, '.gbrain', 'persistence', 'managed-roots');
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, 'brain.json'), JSON.stringify({ version: 1, brain_id: brainId, root: brain }));
  writeFileSync(join(registry, 'stale.json'), JSON.stringify({ version: 1, brain_id: randomUUID(), root: stale }));
  try {
    expect(() => attestLegacyGitMarkerScope({ gitRoot: home, ownerHome: home, brainId, expectedRoots: [brain] }))
      .toThrow('including stale roots');
    expect(readFileSync(marker, 'utf8')).toBe(v1);
    const result = attestLegacyGitMarkerScope({ gitRoot: home, ownerHome: home, brainId, expectedRoots: [brain, stale] });
    expect(readFileSync(result.backup, 'utf8')).toBe(v1);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ version: 2, owner_home: home, scope_roots: [brain, stale] });
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).not.toThrow();
      expect(() => assertManagedFilesystemWrite(join(stale, 'page.md'))).toThrow('managed canonical worktree');
    });
  } finally { rmSync(otherHome, { recursive: true, force: true }); }
}));

test('v2 scope fails closed on missing, malformed, external, or aliased roots', async () => fixture(async ({ home, brain, vault }) => {
  const brainId = randomUUID();
  const marker = join(home, '.git', 'gbrain-managed.json');
  const otherHome = mkdtempSync(join(tmpdir(), 'gbrain-second-home-'));
  const registry = join(home, '.gbrain', 'persistence', 'managed-roots');
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, 'brain.json'), JSON.stringify({ version: 1, brain_id: brainId, root: brain }));
  const alias = join(home, 'brain-alias');
  symlinkSync(brain, alias, 'dir');
  try {
    for (const scope of [undefined, [], ['relative'], [otherHome], [alias]]) {
      writeFileSync(marker, JSON.stringify({ version: 2, managed: true, brain_id: brainId, owner_home: home, scope_roots: scope }));
      await withEnv({ GBRAIN_HOME: otherHome }, () => {
        expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
      });
    }
    writeFileSync(marker, JSON.stringify({ version: 2, managed: true, brain_id: brainId, owner_home: otherHome, scope_roots: [brain] }));
    await withEnv({ GBRAIN_HOME: otherHome }, () => {
      expect(() => assertManagedFilesystemWrite(vault)).toThrow('managed canonical worktree');
    });
  } finally { rmSync(otherHome, { recursive: true, force: true }); }
}));
