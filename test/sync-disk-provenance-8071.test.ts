/**
 * #8071: a managed sync never records, as the bytes an import left on disk, file bytes the page does not hold.
 *
 * The pass settles a path as `matched` when the commit's blob is in the page's import record (`blob_oid` or
 * `disk_blob_oid`, sync-classify.ts). An import that published the pinned blob while the file held other bytes recorded
 * those bytes as `disk_blob_oid` (sync-prepare.ts `syncDiskBytes` read the file at publication), so once they were
 * committed the path matched, the stamp moved `last_commit` past the commit and the page kept the older text, with no hold.
 *
 * Protects, each ending with the edit committed and a plain sync that must import it (`last_commit` = HEAD, the
 * committed body, no hold):
 * - a new file with an uncommitted edit at sync;
 * - a reparse candidate edited after the level read and committed after its freeze, inside one pass (the shape of one
 *   batch commit landing mid-pass);
 * - a page with no import record (imported by an older release) with an uncommitted edit at sync;
 * Control: a CRLF copy of the pinned bytes still records its own blob, and the next sync re-imports nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};
const body = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth.trim() ?? null;
const pageId = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.id;
const incarnationOf = async (engine: BrainEngine) => (await engine.executeRaw<{ i: string }>("SELECT incarnation::text AS i FROM sources WHERE id='default'"))[0]!.i;
const recordKey = async (engine: BrainEngine, slug: string) => `default:${await incarnationOf(engine)}:${await pageId(engine, slug)}`;
const record = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ blob: string | null; disk: string | null }>(
  "SELECT completed_keys->0->>'blob_oid' AS blob, completed_keys->0->>'disk_blob_oid' AS disk FROM op_checkpoints WHERE op=$1 AND fingerprint=$2",
  [SYNC_IMPORT_PROVENANCE_OP, await recordKey(engine, slug)]))[0] ?? null;
/** What the source records once the committed edit is synced: the checkpoint, the page's body and the holds. */
const landed = async (engine: BrainEngine, slug: string, result: Awaited<ReturnType<typeof performManagedSync>>) => ({
  last_commit: (await engine.executeRaw<{ c: string }>("SELECT last_commit AS c FROM sources WHERE id='default'"))[0]!.c,
  body: await body(engine, slug), held: (result.held ?? []).map(hold => hold.path) });

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#8071 disk provenance names only bytes the page holds (${backend})`, () => {
    test('a new file with an uncommitted edit imports its pinned bytes; the edit, once committed, is imported', () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writeFileSync(join(root, 'notes/d.md'), note('notes/d', 'The original body of notes/d.')); commit(root, 'add d');
      const pinned = git(root, 'rev-parse', 'HEAD:notes/d.md');
      writeFileSync(join(root, 'notes/d.md'), note('notes/d', 'The edited body of notes/d.'));
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      expect({ body: await body(engine, 'notes/d'), record: await record(engine, 'notes/d') })
        .toEqual({ body: 'The original body of notes/d.', record: { blob: pinned, disk: pinned } });
      commit(root, 'edit d');
      const synced = await performManagedSync(engine, OPTS);
      expect(await landed(engine, 'notes/d', synced)).toEqual({ last_commit: git(root, 'rev-parse', 'HEAD'), body: 'The edited body of notes/d.', held: [] });
    }, { setup, databaseUrl }), 180_000);

    test('a reparse candidate edited after the level read and committed after its freeze is imported in the same pass', () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"an-older-parser"'::jsonb) WHERE op=$1 AND fingerprint=$2`,
        [SYNC_IMPORT_PROVENANCE_OP, await recordKey(engine, 'notes/b')]);
      await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
      let edited = false, committed = false;
      installFaultHook(async (point, detail) => {
        if (point === 'sync:level_read' && !edited) { edited = true; writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'The edited body of notes/b.')); }
        if (point === 'sync:after_freeze' && (detail as { path?: string }).path === 'notes/b.md' && edited && !committed) { committed = true; commit(root, 'edit b'); }
      });
      const pass = await performManagedSync(engine, OPTS);
      installFaultHook(undefined);
      expect({ edited, committed, status: pass.status }).toEqual({ edited: true, committed: true, status: 'synced' });
      expect(await landed(engine, 'notes/b', pass)).toEqual({ last_commit: git(root, 'rev-parse', 'HEAD'), body: 'The edited body of notes/b.', held: [] });
    }, { setup, databaseUrl }), 180_000);

    test('a page with no import record and an uncommitted edit at sync keeps its body; the edit, once committed, is imported', () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [SYNC_IMPORT_PROVENANCE_OP, await recordKey(engine, 'notes/c')]);
      writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A later body of notes/a.')); commit(root, 'change a');
      writeFileSync(join(root, 'notes/c.md'), note('notes/c', 'The edited body of notes/c.'));
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      expect(await body(engine, 'notes/c')).toBe('The committed body of notes/c.');
      commit(root, 'edit c');
      const synced = await performManagedSync(engine, OPTS);
      expect(await landed(engine, 'notes/c', synced)).toEqual({ last_commit: git(root, 'rev-parse', 'HEAD'), body: 'The edited body of notes/c.', held: [] });
    }, { setup, databaseUrl }), 180_000);

    test('control: a CRLF copy of the pinned bytes still records its own blob, and the next sync re-imports nothing', () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const lf = note('notes/d', 'The body of notes/d.');
      writeFileSync(join(root, 'notes/d.md'), lf); commit(root, 'add d');
      writeFileSync(join(root, 'notes/d.md'), lf.replace(/\n/g, '\r\n'));
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      expect(await record(engine, 'notes/d')).toEqual({ blob: git(root, 'rev-parse', 'HEAD:notes/d.md'), disk: git(root, 'hash-object', 'notes/d.md') });
      const again = await performManagedSync(engine, OPTS);
      expect({ status: again.status, added: again.added, modified: again.modified }).toEqual({ status: 'up_to_date', added: 0, modified: 0 });
    }, { setup, databaseUrl }), 180_000);
  });
}
