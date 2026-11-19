/**
 * GST-2988 PR 3: encrypted secret store backups and the secret_store doctor check. A backup uploads one sealed export
 * (no value, slug, path or rule in clear, never the key) to the configured storage backend and restores only where the
 * key is; with no backend the database backup carries the store. Doctor reports entries, the last backup, keys a host
 * lacks, an escrow never exported, spooled originals, held-back publish commits and side refs. Repo-less and keyless:
 * runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { currentKey, escrowExported, exportKeyEscrow, keyringStatus, markEscrowExported } from '../src/core/secret-store/keyring.ts';
import { markerOf, recordOccurrence, reveal, seal } from '../src/core/secret-store/store.ts';
import { backupDue, backupIfDue, backupStatusFile, backupStore, readBackupStatus, restoreBackup, storageIdentity, BACKUP_OBJECT_PREFIX } from '../src/core/secret-store/backup.ts';
import { createStorage } from '../src/core/storage.ts';
import { runSecrets } from '../src/commands/secrets.ts';
import { secretPublishMaintenance } from '../src/core/git/redact-finish.ts';
import { secretStoreCheck } from '../src/commands/doctor/checks/secret-store.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const TOKEN = ['ghp', 'Zt4q'.repeat(9)].join('_');
const OTHER = 'AKIA' + 'EXAMPLENOTREAL00';
const dirs: string[] = [];
const fresh = (tag: string) => { const dir = mkdtempSync(join(tmpdir(), `gbrain-ss-backup-${tag}-`)); dirs.push(dir); return dir; };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** A gbrain home whose config names a local storage backend at `bucket` (or none). */
function home(bucket?: string): string {
  const dir = fresh('home');
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...(bucket ? { storage: { backend: 'local', bucket: 'b', localPath: bucket } } : {}) }));
  return dir;
}
const env = (dir: string) => ({ GBRAIN_HOME: dir, GBRAIN_SECRET_STORE_KEY: undefined });
const ctx = (engine: BrainEngine, remote = false) => ({ engine, remote, progress: { heartbeat() {} } }) as unknown as DoctorContext;
const capture = async (fn: () => Promise<unknown>) => {
  const out: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  try { await fn(); } finally { console.log = log; }
  return out.join('\n');
};

/** Fresh PGLite brains, opened once for the file (two per backup case, one for the restore probe, one for the no-key host, one for the git case). */
const lite: PGLiteEngine[] = [];
beforeAll(async () => {
  for (let i = 0; i < 5; i++) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); lite.push(engine); }
}, 120_000);
afterAll(async () => { for (const engine of lite.splice(0)) await engine.disconnect(); }, 60_000);
const freshLite = () => { const engine = lite.shift(); if (!engine) throw new Error('no fresh PGLite brain left'); return engine; };

const engines = testBackends().map(name => ({ name, make: async (): Promise<{ engine: BrainEngine; close: () => Promise<void> }> => {
  if (name === 'pglite') return { engine: freshLite(), close: async () => {} };
  const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
  return { engine: pg.engine, close: pg.close };
} }));

for (const { name, make } of engines) {
  describe(`secret store backup (${name})`, () => {
    let a: { engine: BrainEngine; close: () => Promise<void> };
    let b: { engine: BrainEngine; close: () => Promise<void> };
    beforeAll(async () => { a = await make(); b = await make(); }, 120_000);
    afterAll(async () => { await a?.close(); await b?.close(); }, 60_000);

    test('a backup holds no value, slug, path or rule in clear, restores where the key is, and refuses without it or when changed', async () => {
      const bucket = fresh('bucket');
      const dir = home(bucket);
      await withEnv(env(dir), async () => {
        const sealed = await seal(a.engine, { sourceId: 'default', rule: 'github_token', value: TOKEN });
        await recordOccurrence(a.engine, { entryId: sealed.id, sourceId: 'default', slug: 'notes/deploy-plan', field: 'compiled_truth', origin: 'repair', path: 'notes/deploy-plan.md' });
        expect(await backupDue(a.engine)).toBe(true);
        const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
        const out = await backupStore(a.engine, storage);
        expect(out.object.startsWith(BACKUP_OBJECT_PREFIX)).toBe(true);
        expect(out.entries).toBeGreaterThanOrEqual(1);
        expect(readBackupStatus().last_success?.object).toBe(out.object);
        expect(await backupDue(a.engine)).toBe(false);
        const during = await seal(a.engine, { sourceId: 'default', rule: 'aws_access_key', value: OTHER });
        await a.engine.executeRaw("UPDATE secret_store SET created_at = $2::timestamptz + interval '1 millisecond', updated_at = $2::timestamptz + interval '1 millisecond' WHERE id = $1", [during.id, readBackupStatus().last_success!.high_water]);
        expect(await backupDue(a.engine)).toBe(true);
        await a.engine.executeRaw('DELETE FROM secret_store WHERE id = $1', [during.id]);
        expect(await backupDue(a.engine)).toBe(false);
        await recordOccurrence(a.engine, { entryId: sealed.id, sourceId: 'default', slug: 'notes/second-page', field: 'compiled_truth', origin: 'repair', path: 'notes/second-page.md' });
        expect(await backupDue(a.engine)).toBe(true);
        await a.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE entry_id = $1 AND slug = $2', [sealed.id, 'notes/second-page']);
        expect(await backupDue(a.engine)).toBe(false);
        const raw = (await storage.download(out.object)).toString('utf8');
        for (const clear of [TOKEN, 'notes/deploy-plan', 'github_token', sealed.id, currentKey({ create: false })!.key.toString('base64')]) expect(raw).not.toContain(clear);

        await withEnv({ GBRAIN_HOME: home(bucket) }, async () => {
          await expect(restoreBackup(b.engine, storage, out.object)).rejects.toMatchObject({ code: 'secret_store_key_missing' });
          expect(await b.engine.executeRaw('SELECT 1 FROM secret_store')).toEqual([]);
        });
        await expect(restoreBackup(b.engine, storage, out.object)).rejects.toMatchObject({ code: 'invalid_params',
          message: expect.stringContaining('skipped because no page in this brain holds their marker'), suggestion: 'Sync the pages, then run the same restore again.' });
        expect(await b.engine.executeRaw('SELECT 1 FROM secret_store')).toEqual([]);
        expect(await b.engine.executeRaw('SELECT 1 FROM secret_store_occurrence')).toEqual([]);
        await b.engine.putPage('notes/deploy-plan', { type: 'note', title: 'Deploy plan', compiled_truth: `Deploy notes. ${markerOf('github_token', sealed.id)}`, timeline: '', frontmatter: {} }, { sourceId: 'default' });
        const restored = await restoreBackup(b.engine, storage, out.object);
        expect(restored).toMatchObject({ inserted: out.entries, existing: 0, skipped_no_page: 0, unreadable: [] });
        expect((await reveal(b.engine, sealed.id, 'test')).value).toBe(TOKEN);
        expect((await reveal(b.engine, sealed.id, 'test')).occurrences.map(o => o.slug)).toEqual(['notes/deploy-plan']);
        expect(await restoreBackup(b.engine, storage, out.object)).toMatchObject({ inserted: 0, existing: out.entries });

        const doc = JSON.parse(raw);
        const flipped = Buffer.from(doc.ciphertext, 'base64'); flipped[0] ^= 1;
        await storage.upload(`${BACKUP_OBJECT_PREFIX}changed.json`, Buffer.from(JSON.stringify({ ...doc, ciphertext: flipped.toString('base64') })));
        await expect(restoreBackup(b.engine, storage, `${BACKUP_OBJECT_PREFIX}changed.json`)).rejects.toMatchObject({ code: 'secret_store_key_mismatch' });
        await expect(restoreBackup(b.engine, storage, '../elsewhere.json')).rejects.toMatchObject({ code: 'invalid_params' });
      });
    }, 60_000);

    test('a backup reads entries and occurrences in one snapshot, is due again for a different backend or a drifted entry count, and doctor names the backend it never wrote to', async () => {
      const bucket = fresh('bucket'), other = fresh('bucket');
      const dir = home(bucket);
      await withEnv(env(dir), async () => {
        await seal(a.engine, { sourceId: 'default', rule: 'github_token', value: TOKEN });
        const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
        const here = storageIdentity({ backend: 'local', bucket: 'b', localPath: bucket });
        const [before] = await a.engine.executeRaw<{ n: number | string }>('SELECT count(*) AS n FROM secret_store_occurrence');
        let raced = false;
        const racing = new Proxy(a.engine, { get(target, prop) {
          if (prop !== 'executeRaw') { const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v; }
          return async (sql: string, params?: unknown[]) => {
            const rows = await target.executeRaw(sql, params as never);
            if (!raced && /FROM secret_store/.test(sql)) {
              raced = true;
              const late = await seal(target, { sourceId: 'default', rule: 'aws_access_key', value: OTHER + 'RACE' });
              await recordOccurrence(target, { entryId: late.id, sourceId: 'default', slug: 'notes/late', field: 'compiled_truth', origin: 'repair' });
            }
            return rows;
          };
        } }) as BrainEngine;
        const out = await backupStore(racing, storage, here);
        expect(raced).toBe(true);
        expect(out.occurrences).toBe(Number(before!.n));
        expect(await backupDue(a.engine, here)).toBe(true);
        const second = await backupStore(a.engine, storage, here);
        expect(await backupDue(a.engine, here)).toBe(false);
        expect(await backupDue(a.engine, storageIdentity({ backend: 'local', bucket: 'b', localPath: other }))).toBe(true);
        const status = JSON.parse(readFileSync(backupStatusFile(), 'utf8'));
        writeFileSync(backupStatusFile(), JSON.stringify({ ...status, last_success: { ...status.last_success, entries: second.entries - 1 } }));
        expect(await backupDue(a.engine, here)).toBe(true);
        writeFileSync(backupStatusFile(), JSON.stringify(status));
        writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', storage: { backend: 'local', bucket: 'b', localPath: other } }));
        const check = await secretStoreCheck(ctx(a.engine));
        expect(check.message).toContain('never backed up to it');
        expect(check.message).not.toContain('last backed up');
      });
    }, 60_000);

    test('a host with no store key never makes one to back up: maintenance skips and doctor says why; an escrow never exported warns before and after a backup', async () => {
      const bucket = fresh('bucket');
      const engine = await make();
      try {
        await withEnv(env(home()), async () => {
          const sealed = await seal(engine.engine, { sourceId: 'default', rule: 'github_token', value: TOKEN });
          await recordOccurrence(engine.engine, { entryId: sealed.id, sourceId: 'default', slug: 'notes/deploy-plan', field: 'compiled_truth', origin: 'repair' });
        });
        const keyless = home(bucket);
        await withEnv(env(keyless), async () => {
          expect(await backupIfDue(engine.engine)).toBe(false);
          expect(keyringStatus().current).toBeNull();
          expect(readBackupStatus().last_success).toBeNull();
          expect(existsSync(join(bucket, 'gbrain-secret-store'))).toBe(false);
          const check = await secretStoreCheck(ctx(engine.engine));
          expect(check.status).toBe('warn');
          expect(check.message).toContain('has no secret store key, so it does not back the store up');
          await expect(runSecrets(engine.engine, ['backup'])).rejects.toMatchObject({ code: 'secret_store_key_missing' });
          expect(keyringStatus().current).toBeNull();
        });
        await withEnv(env(home(bucket)), async () => {
          await seal(engine.engine, { sourceId: 'default', rule: 'aws_access_key', value: OTHER + 'ESC' });
          expect((await secretStoreCheck(ctx(engine.engine))).message).toContain('has never been exported');
          expect(await backupIfDue(engine.engine)).toBe(true);
          expect((await secretStoreCheck(ctx(engine.engine))).message).toContain('has never been exported');
        });
      } finally { await engine.close(); }
    }, 60_000);

    test('with no storage backend nothing is uploaded and the database backup carries the store', async () => {
      await withEnv(env(home()), async () => {
        const text = await capture(() => runSecrets(a.engine, ['backup']));
        expect(text).toContain('database backup carries the secret store');
        const check = await secretStoreCheck(ctx(a.engine));
        expect(check.details?.backup).toMatchObject({ backend: false, carried_by: 'database_backup' });
      });
    }, 60_000);

    test('maintenance uploads after new entries; a failing backend never stops it and doctor names the failure', async () => {
      const bucket = fresh('bucket');
      const dir = home(bucket);
      await withEnv(env(dir), async () => {
        await seal(a.engine, { sourceId: 'default', rule: 'aws_access_key', value: OTHER + 'X' });
        expect((await secretPublishMaintenance(a.engine)).secret_store_backups).toBe(1);
        expect(readdirSync(join(bucket, 'gbrain-secret-store')).length).toBe(1);
        expect((await secretPublishMaintenance(a.engine)).secret_store_backups).toBeUndefined();

        await seal(a.engine, { sourceId: 'default', rule: 'aws_access_key', value: OTHER + 'Y' });
        const notADir = join(fresh('file'), 'plain-file');
        writeFileSync(notADir, 'not a directory\n');
        writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', storage: { backend: 'local', bucket: 'b', localPath: notADir } }));
        expect((await secretPublishMaintenance(a.engine)).secret_store_backups).toBeUndefined();
        expect(readBackupStatus().last_failure).not.toBeNull();
        const check = await secretStoreCheck(ctx(a.engine));
        expect(check.status).toBe('warn');
        expect(check.message).toContain('The last secret store backup failed');
      });
    }, 60_000);

    test('doctor warns for an escrow never exported and a key in use this host lacks, then clears', async () => {
      await withEnv(env(home()), async () => {
        const engine = (await make());
        try {
          const sealed = await seal(engine.engine, { sourceId: 'default', rule: 'github_token', value: TOKEN });
          await recordOccurrence(engine.engine, { entryId: sealed.id, sourceId: 'default', slug: 'notes/deploy-plan', field: 'compiled_truth', origin: 'repair' });
          let check = await secretStoreCheck(ctx(engine.engine));
          expect(check.status).toBe('warn');
          expect(check.message).toContain('has never been exported');
          const current = currentKey({ create: false })!.id;
          writeFileSync(join(fresh('escrow'), 'escrow.json'), JSON.stringify(exportKeyEscrow(current, 'correct horse battery staple')));
          markEscrowExported(current);
          expect(escrowExported().has(current)).toBe(true);
          check = await secretStoreCheck(ctx(engine.engine));
          expect(check.status).toBe('ok');
          expect(check.message).toContain('no storage backend, so the database backup carries the store');

          await withEnv({ GBRAIN_HOME: home() }, async () => {
            const elsewhere = await secretStoreCheck(ctx(engine.engine));
            expect(elsewhere.status).toBe('warn');
            expect(elsewhere.message).toContain('secret_store_key_forked');
            expect(JSON.stringify(elsewhere)).not.toContain(TOKEN);
          });
        } finally { await engine.close(); }
      });
    }, 60_000);
  });
}

describe('secret store doctor: held-back commits and side refs (git, local only)', () => {
  test('counts held-back publish commits and names side refs that reach a redaction backup ref; a remote caller gets neither', async () => {
    await withEnv(env(home()), async () => {
      const engine = freshLite();
      {
        const root = fresh('repo'), remote = fresh('remote');
        const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
        git(root, 'init', '-q', '-b', 'main'); git(root, 'remote', 'add', 'origin', remote);
        writeFileSync(join(root, 'a.md'), 'a\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'a'); git(root, 'push', '-q', 'origin', 'main');
        writeFileSync(join(root, 'b.md'), 'b\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'old b');
        git(root, 'update-ref', 'refs/gbrain/backup/redact-20261118T000000Z', 'HEAD');
        git(root, 'branch', 'side');
        git(root, 'reset', '-q', '--soft', 'HEAD~1'); git(root, 'commit', '-qm', 'b rebuilt');
        writeFileSync(join(root, 'c.md'), 'c\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'gbrain: files held back from publish', '-m', 'Gbrain-Redact-Held: refs/gbrain/backup/redact-20261118T000000Z');
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await seal(engine, { sourceId: 'default', rule: 'github_token', value: TOKEN });
        const local = await secretStoreCheck(ctx(engine));
        expect(local.status).toBe('warn');
        expect(local.details?.checkouts).toEqual([{ source_id: 'default', held: 1, side_refs: ['refs/heads/side'] }]);
        expect(local.message).toContain('1 held-back publish commit(s)');
        expect(local.message).toContain('refs/heads/side');
        const remoteCheck = await secretStoreCheck(ctx(engine, true));
        expect(remoteCheck.details?.checkouts).toBeUndefined();
        expect(remoteCheck.message).not.toContain('refs/heads/side');
      }
    });
  }, 60_000);
});
