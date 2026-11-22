/** #9771: code projection freshness must not veto a history-proven one-sided Git edit. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example',
  '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'synthetic code'); };
const opts = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, strategy: 'code' as const };
const before = 'def greet(name):\n    return "hello " + name\n';
const after = 'def greet(name):\n    return "welcome " + name\n';
const write = (engine: BrainEngine, sql: string, params: unknown[] = []) => engine.transaction(tx =>
  withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  for (const mode of ['unsealed', 'old-chunker', 'history', 'db-body', 'db-title', 'db-timeline', 'sealed-db-body', 'sealed-db-title', 'sealed-db-timeline'] as const) {
    test(`#9771 [${backend}] history-proven code import with ${mode}`, () => managedBrain(async ({ engine, root }) => {
      await performManagedSync(engine, opts);
      // Code-only selections need not advance last_commit. A missing baseline remains unknown;
      // this fix must not infer import safety merely from the path or a stale content hash.
      if (mode !== 'history') await write(engine, "UPDATE sources SET last_commit=$1 WHERE id='default'", [git(root, 'rev-parse', 'HEAD')]);
      const [page] = await engine.executeRaw<{ id: number; slug: string }>(
        "SELECT id, slug FROM pages WHERE source_id='default' AND source_path='src/tool.py'");
      expect(page).toBeDefined();
      await write(engine, "DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
      // Pre-provenance pages have no managed writer attestation. The hash still names the original code;
      // the text projection may need repair, or a newer release may compute a different chunker hash.
      await write(engine, `UPDATE pages SET knowledge_revision=$2::uuid, revision_write_request_id=NULL,
        text_projection_revision=NULL WHERE id=$1`, [page!.id, randomUUID()]);
      if (mode === 'old-chunker') await write(engine, "UPDATE pages SET content_hash='historical-code-hash' WHERE id=$1", [page!.id]);
      if (mode.endsWith('db-body')) await write(engine, "UPDATE pages SET compiled_truth='Database-only work.' WHERE id=$1", [page!.id]);
      if (mode.endsWith('db-title')) await write(engine, "UPDATE pages SET title='Database-only title' WHERE id=$1", [page!.id]);
      if (mode.endsWith('db-timeline')) await write(engine, "UPDATE pages SET timeline='Database-only timeline' WHERE id=$1", [page!.id]);
      if (mode.startsWith('sealed-')) await write(engine, "UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1", [page!.id]);
      await engine.executeRaw(`UPDATE sources SET config=config || '{"mirror_read_only":true}'::jsonb WHERE id='default'`);
      writeFileSync(join(root, 'src/tool.py'), after); commit(root);
      await performManagedSync(engine, { ...opts, full: true });
      if (mode === 'history') {
        expect((await retryHeld(engine, 'default')).scheduled).toBe(1);
        await performManagedSync(engine, { ...opts, full: true });
      }
      const held = await engine.executeRaw<{ code: string }>(
        "SELECT completed_keys->0->>'code' AS code FROM op_checkpoints WHERE op='sync-hold' AND completed_keys->0->>'path'='src/tool.py'");
      const current = await engine.getPage(page!.slug, { sourceId: 'default' });
      if (mode.includes('db-') || mode === 'history') {
        expect(held.map(row => row.code)).toEqual(['file_drift']);
        expect(current!.compiled_truth).toBe(mode.endsWith('db-body') ? 'Database-only work.' : before);
        if (mode.endsWith('db-title')) expect(current!.title).toBe('Database-only title');
        if (mode.endsWith('db-timeline')) expect(current!.timeline).toBe('Database-only timeline');
      } else {
        expect(held).toEqual([]);
        expect(current!.compiled_truth).toBe(after);
        expect(current!.text_projection_revision).toBe(current!.knowledge_revision);
        const records = await engine.executeRaw<{ revision: string }>(
          "SELECT completed_keys->0->>'revision' AS revision FROM op_checkpoints WHERE op='sync-import-provenance' AND completed_keys->0->>'page_id'=$1", [String(page!.id)]);
        expect(records.map(row => row.revision)).toEqual([current!.knowledge_revision!]);
        await performManagedSync(engine, { ...opts, full: true });
        expect((await engine.getPage(page!.slug, { sourceId: 'default' }))!.knowledge_revision).toBe(current!.knowledge_revision);
      }
      // test-reads-source-ok[raw-bytes]: reads the synthetic checkout fixture, not repository source; proves mirror bytes stay unchanged.
      expect(readFileSync(join(root, 'src/tool.py'), 'utf8')).toBe(after);
      expect(git(root, 'status', '--porcelain')).toBe('');
    }, { databaseUrl, setup: ({ root }) => {
      git(root, 'init', '-q'); mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/tool.py'), before); commit(root);
    } }), 180_000);
  }
}
