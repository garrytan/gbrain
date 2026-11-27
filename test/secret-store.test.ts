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
import { isAllowed, listEntries, recordOccurrence, reveal, seal } from '../src/core/secret-store/store.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
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

describe('reveal_secret counts only a place whose marker the caller can see (GST-3065)', () => {
  test('a non-owner with a reveal grant is refused an original whose marker it cannot read itself (an owner-only take, timeline or fact row, a body copy in a stripped takes fence, a private fact fence row, a take holder outside its allowlist, a removed marker, a row edited or deleted, a row its token may not read, a commit), and is told only the places that counted; the owner and the local CLI still reveal', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SECRET_STORE_KEY: undefined }, async () => {
    for (const { name, engine } of engines) {
      const op = operationsByName.reveal_secret!;
      const values = { open: 'AKIA' + 'OPENROWVALUE0001', take: 'AKIA' + 'OWNERONLYTAKE001', timeline: 'AKIA' + 'OWNERONLYTIME001', fact: 'AKIA' + 'OWNERONLYFACT001',
        privateFact: 'AKIA' + 'PRIVATEFENCEFAC1', holder: 'AKIA' + 'OTHERHOLDERTAKE1', removed: 'AKIA' + 'MARKERREMOVED001', gone: 'AKIA' + 'DELETEDTAKEROW01', edited: 'AKIA' + 'EDITEDTAKEROW001', commit: 'AKIA' + 'COMMITONLYVAL001' };
      const ids = Object.fromEntries(await Promise.all(Object.entries(values).map(async ([k, v]) => [k, (await seal(engine, { sourceId: 'default', rule: 'aws_access_key', value: v })).id]))) as Record<keyof typeof values, string>;
      const marker = (id: string) => `<REDACTED:aws_access_key:${id}>`;
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('oo-src', 'oo-src', '{"owner_only":true}'::jsonb) ON CONFLICT (id) DO NOTHING`);
      await importFromContent(engine, 'notes/oo-chat', `---\ntitle: Chat\n---\nPrivate chat ${marker(ids.open)}.\n`, { sourceId: 'oo-src' });
      const body = ['---', 'title: Shared plan', '---', `Shared plan ${marker(ids.open)}.`, '',
        '<!--- gbrain:facts:begin -->', '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
        '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
        `| 1 | Keeps ${marker(ids.privateFact)} | fact | 1.0 | private | medium | 2026-01-01 |  | fixture |  |`, '<!--- gbrain:facts:end -->', '',
        '<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |', '|---|-------|------|-----|--------|-------|--------|',
        `| 1 | Plan ${marker(ids.take)} | take | world | 0.5 | 2026-06 | fixture |`, '<!--- gbrain:takes:end -->', ''].join('\n');
      await importFromContent(engine, 'notes/shared-plan', body, { sourceId: 'default' });
      const pageOf = async (slug: string, sourceId: string) => Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1 AND source_id=$2', [slug, sourceId]))[0]!.id);
      const chatId = await pageOf('notes/oo-chat', 'oo-src');
      const pageId = await pageOf('notes/shared-plan', 'default');
      const take = async (rowNum: number, claim: string, holder: string) => (await engine.executeRaw<{ id: number }>(
        `INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, $2, $3, 'take', $4) RETURNING id`, [pageId, rowNum, claim, holder]))[0]!.id;
      const taken = await take(51, 'Plan ' + marker(ids.take), 'world');
      const other = await take(52, 'Holds ' + marker(ids.holder), 'alice-example');
      const gone = await take(53, 'Old ' + marker(ids.gone), 'world');
      const edited = await take(54, 'Draft ' + marker(ids.edited), 'world');
      await take(55, 'Also ' + marker(ids.open), 'world');
      const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-06-14', $2) RETURNING id`, [pageId, 'Met ' + marker(ids.timeline)]);
      const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES ('default', 'notes/shared-plan', $1, 'fact', 'world', 'fixture') RETURNING id`, ['Uses ' + marker(ids.fact)]);
      await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES
        ('takes', $1, 'pages', $3, 'default'), ('timeline_entries', $2, 'pages', $3, 'default'), ('facts', $4, 'pages', $3, 'default')`, [String(taken), String(row!.id), String(chatId), String(fact!.id)]);
      const at = { sourceId: 'default', pageId, slug: 'notes/shared-plan', origin: 'repair' as const };
      await recordOccurrence(engine, { ...at, entryId: ids.open, field: 'compiled_truth' });
      await recordOccurrence(engine, { ...at, sourceId: 'oo-src', pageId: chatId, slug: 'notes/oo-chat', entryId: ids.open, field: 'compiled_truth' });
      await recordOccurrence(engine, { ...at, pageId: null, entryId: ids.open, field: 'compiled_truth', origin: 'publish_rebuild', commit: 'b'.repeat(40), path: 'notes/shared-plan.md', line: 4 });
      await recordOccurrence(engine, { ...at, entryId: ids.take, field: `takes/${taken}/claim` });
      await recordOccurrence(engine, { ...at, entryId: ids.take, field: 'compiled_truth' });
      await recordOccurrence(engine, { ...at, entryId: ids.timeline, field: `timeline_entries/${row!.id}/summary` });
      await recordOccurrence(engine, { ...at, entryId: ids.fact, field: `facts/${fact!.id}/fact` });
      await recordOccurrence(engine, { ...at, entryId: ids.privateFact, field: 'compiled_truth' });
      await recordOccurrence(engine, { ...at, entryId: ids.holder, field: `takes/${other}/claim` });
      await recordOccurrence(engine, { ...at, entryId: ids.removed, field: 'compiled_truth' });
      await recordOccurrence(engine, { ...at, entryId: ids.gone, field: `takes/${gone}/claim` });
      await recordOccurrence(engine, { ...at, entryId: ids.edited, field: `takes/${edited}/claim` });
      await recordOccurrence(engine, { ...at, pageId: null, entryId: ids.commit, field: 'compiled_truth', origin: 'publish_rebuild', commit: 'a'.repeat(40), path: 'notes/shared-plan.md', line: 3 });

      const nonOwner = remoteCtx(engine, ['get_page', 'takes_list', 'get_timeline', 'recall', 'reveal_secret']);
      const noTakes = remoteCtx(engine, ['get_page', 'reveal_secret']);
      const open = await op.handler(nonOwner, { id: ids.open }) as { value: string; occurrences: Array<{ slug: string; field: string; commit: string | null }> };
      expect(open.value, name).toBe(values.open);
      expect(open.occurrences.map(o => [o.slug, o.field, o.commit]), name).toEqual([['notes/shared-plan', 'compiled_truth', null]]);
      expect(await op.handler(nonOwner, { id: ids.gone }), `${name} gone before delete`).toMatchObject({ value: values.gone });
      await expect(op.handler(noTakes, { id: ids.gone }), `${name} gone without takes_list`).rejects.toMatchObject({ code: 'secret_reveal_forbidden' });
      expect(await op.handler(noTakes, { id: ids.open }), `${name} open without takes_list`).toMatchObject({ value: values.open });
      expect(await op.handler(nonOwner, { id: ids.edited }), `${name} edited before edit`).toMatchObject({ value: values.edited });
      await engine.executeRaw('DELETE FROM takes WHERE id = $1', [gone]);
      await engine.executeRaw("UPDATE takes SET claim = 'Draft done' WHERE id = $1", [edited]);
      for (const k of ['take', 'timeline', 'fact', 'privateFact', 'holder', 'removed', 'gone', 'edited', 'commit'] as const) {
        await expect(op.handler(nonOwner, { id: ids[k] }), `${name} ${k}`).rejects.toMatchObject({ code: 'secret_reveal_forbidden' });
      }
      for (const k of ['take', 'timeline', 'fact'] as const) {
        expect(await withCallerAccess({ owner: true }, () => op.handler(nonOwner, { id: ids[k] })), `${name} owner ${k}`).toMatchObject({ value: values[k] });
      }
      for (const k of Object.keys(values) as (keyof typeof values)[]) {
        expect(await op.handler({ engine, config: {}, logger, dryRun: false, remote: false } as unknown as OperationContext, { id: ids[k] }), `${name} local ${k}`).toMatchObject({ value: values[k] });
      }
    }
  }), 120_000);
});
