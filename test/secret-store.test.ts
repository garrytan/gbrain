/**
 * GST-2988: the secret store. Keys (keyring, env override, escrow), sealing and reading originals, redaction through
 * `gbrain repair secret-spans` keeping originals and redacting retained versions, restore of a false positive, and the
 * reveal_secret trust boundary. Repo-less and keyless (no provider key, no setting): runs on PGLite, and on Postgres
 * when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { currentKey, exportKeyEscrow, importKeyEscrow, keyById, keyringDir, keyringStatus } from '../src/core/secret-store/keyring.ts';
import { isAllowed, listEntries, reveal, seal } from '../src/core/secret-store/store.ts';
import { applyRestore, previewRestore } from '../src/core/secret-store/restore.ts';
import { operationsByName } from '../src/core/operations.ts';
import { resolveGrantProfile } from '../src/core/grants/service.ts';
import type { ClientGrant } from '../src/core/grants/model.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const logger = { info() {}, warn() {}, error() {} };
// Obviously fake key shapes, assembled so no literal key sits in the source.
const OPENAI = ['sk', 'proj', 'EXAMPLExNOTxREALxEXAMPLExNOTxREAL'].join('-');
const AWS = 'AKIA' + 'EXAMPLENOTREAL00';
const MARKER = /<REDACTED:([a-z0-9_]+):(ss_[0-9a-f]{12})>/g;

const homes: string[] = [];
const freshHome = () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-secret-store-')); homes.push(dir); return dir; };
afterAll(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

describe('keyring', () => {
  test('first use makes a 0600 key; a key readable by others is never used or overwritten; escrow round-trips', () => withEnv({ GBRAIN_HOME: freshHome(), GBRAIN_SECRET_STORE_KEY: undefined }, async () => {
    expect(currentKey({ create: false })).toBeNull();
    const first = currentKey({ create: true })!;
    expect(first.created).toBe(true);
    const file = join(keyringDir(), `${first.id}.key`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(currentKey({ create: false })!.id).toBe(first.id);

    const escrow = exportKeyEscrow(first.id, 'correct horse battery staple');
    expect(JSON.stringify(escrow)).not.toContain(first.key.toString('base64'));
    expect(() => importKeyEscrow(escrow, 'wrong passphrase here')).toThrow(/passphrase/i);

    const bytes = readFileSync(file, 'utf8');
    chmodSync(file, 0o644);
    const second = currentKey({ create: true })!;
    expect(second.id).not.toBe(first.id);
    expect(second.created).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(keyById(first.id)).toBeNull();
    expect(keyringStatus().keys.find(k => k.id === first.id)).toMatchObject({ readable: false, mode_ok: false });
    chmodSync(file, 0o600);
    expect(keyById(first.id)?.equals(first.key)).toBe(true);
  }));

  test('GBRAIN_SECRET_STORE_KEY overrides the keyring and never writes it', () => withEnv({ GBRAIN_HOME: freshHome(), GBRAIN_SECRET_STORE_KEY: Buffer.alloc(32, 7).toString('base64') }, async () => {
    const key = currentKey({ create: true })!;
    expect(key.origin).toBe('env');
    expect(existsSync(keyringDir())).toBe(false);
    await withEnv({ GBRAIN_SECRET_STORE_KEY: 'too-short' }, async () => { expect(() => currentKey({ create: true })).toThrow(/32 bytes/); });
  }));
});

const engines: Array<{ name: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;
const home = freshHome();
beforeAll(() => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema();
  engines.push({ name: 'pglite', engine: lite });
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push({ name: 'postgres', engine: pg.engine });
    closePostgres = pg.close;
  }
}), 120_000);
afterAll(async () => { for (const { engine } of engines) await engine.disconnect(); await closePostgres?.(); });

const remoteCtx = (engine: BrainEngine, allowedOperations: string[] | null) => ({ engine, config: { engine: engine.kind }, logger, dryRun: false, remote: true,
  transport: 'http', sourceId: 'default', takesHoldersAllowList: ['world'],
  auth: { token: 't', clientId: 'client-example', clientName: 'agent-example', scopes: ['read'], allowedOperations, sourceId: 'default' } }) as unknown as OperationContext;

describe('secret store on a repo-less brain', () => {
  test('seal, reveal, dedupe and tamper refusal; no value in any row', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SECRET_STORE_KEY: undefined }, async () => {
    for (const { name, engine } of engines) {
      const a = await seal(engine, { sourceId: 'default', rule: 'openai', value: OPENAI });
      const b = await seal(engine, { sourceId: 'default', rule: 'openai', value: OPENAI });
      expect(b.id, name).toBe(a.id);
      expect(b.created).toBe(false);
      expect((await reveal(engine, a.id, 'test')).value).toBe(OPENAI);
      const rows = await engine.executeRaw('SELECT * FROM secret_store');
      expect(JSON.stringify(rows)).not.toContain(OPENAI);
      await engine.executeRaw("UPDATE secret_store SET rule='aws_access_key' WHERE id=$1", [a.id]);
      await expect(reveal(engine, a.id, 'test')).rejects.toMatchObject({ code: 'secret_store_key_mismatch' });
      await engine.executeRaw("UPDATE secret_store SET rule='openai' WHERE id=$1", [a.id]);
      await engine.executeRaw("UPDATE secret_store SET key_id='0000000000000000' WHERE id=$1", [a.id]);
      await expect(reveal(engine, a.id, 'test')).rejects.toMatchObject({ code: 'secret_store_key_missing' });
      await engine.executeRaw('DELETE FROM secret_store');
    }
  }));

  test('repair secret-spans keeps originals, redacts retained versions; restore puts a false positive back and sticks', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SECRET_STORE_KEY: undefined }, async () => {
    for (const { name, engine } of engines) {
      const slug = 'notes/store-example';
      const body = `# Store Example\n\nOld key ${OPENAI} and ${AWS}.\n`;
      await importFromContent(engine, slug, `---\ntype: note\ntitle: Store Example\n---\n\n${body}`, { noEmbed: true, sourceId: 'default' });
      await engine.createVersion(slug, { sourceId: 'default' });
      await importFromContent(engine, 'notes/forged-example', '---\ntype: note\ntitle: Forged\n---\n\nCopied marker: PLACEHOLDER\n', { noEmbed: true, sourceId: 'default' });
      const scope = await resolveRepairScope(engine, 'default');
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('secret-spans', scope, { explicit: true, sourceFlag: 'default', slugs: [slug] });
      const result = await (await repairRunner(engine, { apply: true, logger })).run('secret-spans', scope, { explicit: true, sourceFlag: 'default', slugs: [slug], expect: preview.preview_hash });
      expect(result.outcomes, name).toEqual({ redacted: 1 });

      const [page] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug=$1', [slug]);
      const markers = [...page!.compiled_truth.matchAll(MARKER)];
      expect(markers.map(m => m[1]).sort()).toEqual(['aws_access_key', 'openai']);
      const versions = await engine.executeRaw<{ compiled_truth: string }>('SELECT v.compiled_truth FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug=$1', [slug]);
      expect(versions.length).toBeGreaterThan(0);
      expect(JSON.stringify(versions)).not.toContain(OPENAI);
      expect(versions[0]!.compiled_truth).toContain(markers.find(m => m[1] === 'openai')![0]);

      const openaiId = markers.find(m => m[1] === 'openai')![2]!;
      expect((await reveal(engine, openaiId, 'test')).value).toBe(OPENAI);
      const listed = await listEntries(engine, { slug });
      expect(listed.map(e => e.id).sort()).toEqual(markers.map(m => m[2]).sort());
      expect(JSON.stringify(listed)).not.toContain(OPENAI);

      // A marker pasted into another page binds to nothing: restore leaves it alone.
      const forgedText = `Copied marker: ${markers.find(m => m[1] === 'openai')![0]}`;
      await importFromContent(engine, 'notes/forged-example', `---\ntype: note\ntitle: Forged\n---\n\n${forgedText}\n`, { noEmbed: true, sourceId: 'default' });

      const restorePreview = await previewRestore(engine, openaiId);
      expect(restorePreview.pages.map(p => p.slug)).toEqual([slug]);
      await expect(applyRestore(engine, openaiId, 'not-the-hash', 'test')).rejects.toMatchObject({ code: 'preview_changed' });
      const restored = await applyRestore(engine, openaiId, restorePreview.hash, 'test');
      expect(restored.restored).toEqual([expect.objectContaining({ slug, markers: 1 })]);
      const [after] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug=$1', [slug]);
      expect(after!.compiled_truth.replace(MARKER, '<REDACTED:$1>')).toBe(body.trim().replace(AWS, '<REDACTED:aws_access_key>'));
      expect(after!.compiled_truth).toContain(OPENAI);
      const [forged] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug='notes/forged-example'");
      expect(forged!.compiled_truth).toContain(forgedText);
      expect(await isAllowed(engine, 'default', OPENAI)).toBe(true);
      expect(await isAllowed(engine, 'default', AWS)).toBe(false);

      // A restored value stays back: running repair secret-spans again over the page leaves it alone.
      const again = await (await repairRunner(engine, { apply: false, logger })).run('secret-spans', scope, { explicit: true, sourceFlag: 'default', slugs: [slug] });
      const rerun = await (await repairRunner(engine, { apply: true, logger })).run('secret-spans', scope, { explicit: true, sourceFlag: 'default', slugs: [slug], expect: again.preview_hash });
      expect(rerun.outcomes?.redacted ?? 0, name).toBe(0);
      const [kept] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug=$1', [slug]);
      expect(kept!.compiled_truth, name).toContain(OPENAI);

      // reveal_secret: the trusted CLI reads; a remote caller needs reveal_secret named in its grant and a readable page.
      const op = operationsByName.reveal_secret!;
      const awsId = markers.find(m => m[1] === 'aws_access_key')![2]!;
      expect(await op.handler({ engine, config: {}, logger, dryRun: false, remote: false } as unknown as OperationContext, { id: awsId })).toMatchObject({ value: AWS });
      await expect(op.handler({ engine, config: {}, logger, dryRun: false, remote: true, transport: 'stdio' } as unknown as OperationContext, { id: awsId })).rejects.toMatchObject({ code: 'secret_reveal_forbidden' });
      await expect(op.handler(remoteCtx(engine, null), { id: awsId })).rejects.toMatchObject({ code: 'secret_reveal_forbidden' });
      await expect(op.handler(remoteCtx(engine, ['get_page']), { id: awsId })).rejects.toMatchObject({ code: 'secret_reveal_forbidden' });
      expect(await op.handler(remoteCtx(engine, ['get_page', 'reveal_secret']), { id: awsId })).toMatchObject({ value: AWS, rule: 'aws_access_key' });
      await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE slug=$1", [slug]);
      await expect(op.handler(remoteCtx(engine, ['get_page', 'reveal_secret']), { id: awsId })).rejects.toMatchObject({ code: 'secret_reveal_forbidden' });
    }
  }), 120_000);
});

describe('reveal_secret stays approved by name in profile grants', () => {
  const profiles = ['memory-reader', 'memory-writer', 'coding-agent', 'operator', 'delegating-agent', 'full'] as const;

  test('no profile grant names reveal_secret on its own', () => {
    for (const profile of profiles) {
      const grant = resolveGrantProfile({ profile, sourceId: 'default', boundTools: ['get_page'], boundSlugPrefixes: ['agents/'] });
      expect(grant.allowedOperations, profile).not.toContain('reveal_secret');
      expect(grant.allowedOperations, profile).toContain('get_page');
    }
  });

  test('a regrant keeps reveal_secret only when the owner already named it', () => {
    const named = { allowedOperations: ['get_page', 'reveal_secret'] } as unknown as ClientGrant;
    const unnamed = { allowedOperations: ['get_page'] } as unknown as ClientGrant;
    expect(resolveGrantProfile({ profile: 'memory-reader', sourceId: 'default', existing: named }).allowedOperations).toContain('reveal_secret');
    expect(resolveGrantProfile({ profile: 'memory-reader', sourceId: 'default', existing: unnamed }).allowedOperations).not.toContain('reveal_secret');
  });
});
