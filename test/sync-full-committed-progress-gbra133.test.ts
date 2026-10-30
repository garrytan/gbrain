/**
 * GBRA-133 PR 3a: a classic full sync (first sync, or --full) commits through runImport, so it must note committed
 * progress for each page it imports. The sync hard deadline extends only on committed progress; without these notes a
 * first sync of a large checkout that is importing steadily stopped at its deadline as `sync_deadline_stalled`.
 * Protects: a full sync that imports pages notes committed progress once per imported page, and a full re-sync of an
 * unchanged checkout notes none. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { onCommittedProgress } from '../src/core/forward-progress.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const home = mkdtempSync(join(tmpdir(), 'gbrain-full-progress-'));
const engines = new Map<string, BrainEngine>();
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  for (const backend of testBackends()) {
    if (backend === 'pglite') { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engines.set(backend, pglite); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.set(backend, pg.engine); closePostgres = pg.close; }
  }
  for (const engine of engines.values()) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);
afterAll(async () => {
  for (const engine of engines.values()) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

for (const backend of testBackends()) {
  describe(`a classic full sync notes committed progress per imported page (${backend})`, () => {
    test('a first sync of 12 files notes 12 commits; a full re-sync of the unchanged checkout notes none', () => withEnv({ GBRAIN_HOME: home }, async () => {
      const engine = engines.get(backend)!;
      const repoPath = mkdtempSync(join(home, `repo-${backend}-`));
      mkdirSync(join(repoPath, 'notes'), { recursive: true });
      git(repoPath, 'init', '-q');
      for (let i = 0; i < 12; i++) writeFileSync(join(repoPath, `notes/n${i}.md`), `---\ntype: concept\ntitle: Note ${i}\n---\n\nThe body of note ${i}.\n`);
      git(repoPath, 'add', '-A');
      git(repoPath, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
      const sourceId = `full-${backend}`;
      // One worker: parallel import workers connect to the configured database, not this test's isolated one.
      const opts = { repoPath, sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 };
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, repoPath]);
      let commits = 0;
      const off = onCommittedProgress(() => { commits++; });
      try {
        const first = await performSync(engine, opts as never);
        expect(first.status).toBe('first_sync');
        expect(first.added).toBe(12);
        expect(commits).toBe(12);
        commits = 0;
        await performSync(engine, { ...opts, full: true } as never);
        expect(commits).toBe(0);
      } finally { off(); }
    }), 120_000);
  });
}
