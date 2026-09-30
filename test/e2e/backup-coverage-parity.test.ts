import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { computeBackupCoverage } from '../../src/core/backup/coverage.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { makeGitFixture } from '../helpers/git-fixture.ts';

(hasDatabase() ? describe : describe.skip)('backup remote evidence across isolated engines', () => {
  let temporary: string;
  let originalHome: string | undefined;
  let remote: string;
  let pglite: PGLiteEngine;
  let postgres: BrainEngine;

  beforeAll(async () => {
    temporary = mkdtempSync(join(tmpdir(), 'gbrain-backup-parity-'));
    originalHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = temporary;
    const root = join(temporary, 'memory');
    remote = join(temporary, 'origin.git');
    mkdirSync(root);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    await makeGitFixture(root);
    git('branch', '-M', 'main');
    writeFileSync(join(root, 'memory.md'), '# Source fixture\n');
    git('add', '.'); git('commit', '-m', 'fixture');
    git('init', '--bare', '-b', 'main', remote);
    git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main');
    pglite = new PGLiteEngine();
    await pglite.connect({}); await pglite.initSchema();
    postgres = await setupDB();
    for (const engine of [pglite, postgres]) {
      await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
      await engine.putPage('db-only-note', { type: 'note', title: 'DB-only fixture', compiled_truth: 'Not a source file', frontmatter: {} });
      await engine.executeRaw("INSERT INTO facts (fact, source, source_id) VALUES ('DB-only fixture fact', 'fixture', 'default')");
      await engine.setConfig('backup.drill_fixture', 'database-only-value');
    }
  }, 120_000);

  afterAll(async () => {
    if (pglite) await pglite.disconnect();
    await teardownDB();
    if (originalHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = originalHome;
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  });

  test('matching remote files never promise DB-only page, fact or config recovery', async () => {
    const statuses = [];
    for (const engine of [pglite, postgres]) {
      const status = await computeBackupCoverage(engine, { localGitProbes: true, verifyRemoteRefs: true });
      expect(status.totals.recoverable_repos).toBe(1);
      expect(status.recovery_scope).toContain('not a full database backup');
      expect(await engine.getConfig('backup.drill_fixture')).toBe('database-only-value');
      expect((await engine.executeRaw('SELECT fact FROM facts')).length).toBe(1);
      statuses.push(status.totals);
    }
    expect(statuses[0]).toEqual(statuses[1]);
  });

  test('removed remote leaves both engines warning despite their intact local tracking refs', async () => {
    rmSync(remote, { recursive: true });
    for (const engine of [pglite, postgres]) {
      const status = await computeBackupCoverage(engine, { localGitProbes: true, verifyRemoteRefs: true });
      expect(status.overall).toBe('warn');
      expect(status.totals.configured_repos).toBe(1);
      expect(status.totals.recoverable_repos).toBe(0);
      expect(status.assets[0].verification?.state).toBe('unavailable');
    }
  });
});
