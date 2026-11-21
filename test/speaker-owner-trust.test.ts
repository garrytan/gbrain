/**
 * GST-3216 PR 2: a speaker_owner marker is honored only when a trusted local importer wrote the page's live revision,
 * its shape is valid and its member is the page source's. Repo-less brains, PGLite and (with DATABASE_URL) Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindMemberSource } from '../src/core/access/member-sources.ts';
import { buildSpeakerOwner, parseSpeakerOwner, readSpeakerOwners } from '../src/core/identity/speaker-owner.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

setDefaultTimeout(60_000);

const SLUG = 'conversations/2026-01-02-claude-code-example';
const page = (marker: Record<string, unknown> | null, body = '**User** (2026-01-02T00:00:00Z): hello\n\n**Assistant** (2026-01-02T00:00:01Z): hi') =>
  ['---', 'type: conversation', 'title: Example session', 'date: 2026-01-02',
    ...(marker ? [`speaker_owner: ${JSON.stringify(marker)}`] : []), '---', '', body, ''].join('\n');
const OWNER = { label: 'User', basis: 'session_user', turns: 1 };

describe('speaker_owner shape', () => {
  test('a valid marker parses; a bad basis, label or turn count does not', () => {
    expect(parseSpeakerOwner(OWNER)).toEqual(OWNER as never);
    expect(parseSpeakerOwner({ ...OWNER, basis: 'guess' })).toBeNull();
    expect(parseSpeakerOwner({ ...OWNER, label: 'User\n**Assistant**' })).toBeNull();
    expect(parseSpeakerOwner({ ...OWNER, label: 'x'.repeat(81) })).toBeNull();
    expect(parseSpeakerOwner({ ...OWNER, turns: 0 })).toBeNull();
    expect(parseSpeakerOwner({ ...OWNER, member: 'Not A Member Id' })).toBeNull();
    expect(buildSpeakerOwner('  Me ', 'is_from_me', 3, 'alice-example')).toEqual({ label: 'Me', basis: 'is_from_me', turns: 3, member: 'alice-example' });
    expect(buildSpeakerOwner('', 'is_from_me', 3, null)).toBeNull();
  });
});

for (const backend of testBackends()) describe(`[${backend}] speaker_owner trust (repo-less)`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const pg = new PGLiteEngine(); await pg.connect({ engine: 'pglite' } as never); await pg.initSchema(); engine = pg; close = () => pg.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); resetGateway(); }, 60_000);
  beforeEach(async () => {
    resetGateway();
    for (const sql of ['DELETE FROM access_member_sources', 'DELETE FROM access_members', 'DELETE FROM pages',
      "DELETE FROM sources WHERE id <> 'default'", "DELETE FROM config WHERE key = 'access.owner_member'"]) await engine.executeRaw(sql);
  });

  const ctx = (remote: boolean): OperationContext => ({
    engine, config: { engine: backend, embedding_disabled: true } as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default',
  });
  const putPage = (remote: boolean, slug: string, content: string) =>
    operations.find(o => o.name === 'put_page')!.handler(ctx(remote), { slug, content });
  const importer = (slug: string, content: string, sourceId = 'default', via: string | null = 'cli:transcripts-ingest') =>
    importFromContent(engine, slug, content, { noEmbed: true, sourceId, ...(via ? { ingested_via: via, source_kind: 'transcript:claude-code' } : {}) });
  const read = async (slug = SLUG, source_id = 'default') => (await readSpeakerOwners(engine, [{ source_id, slug }]))[0];

  test('the transcripts importer\'s marker is honored', async () => {
    await importer(SLUG, page(OWNER));
    expect(await read()).toEqual({ slug: SLUG, source_id: 'default', status: 'trusted', marker: OWNER as never });
  });

  test('a page without a marker is speaker-unknown', async () => {
    await importer(SLUG, page(null));
    expect((await read())!.status).toBe('absent');
  });

  test('a remote put_page that forges a marker is not honored', async () => {
    await putPage(true, SLUG, page(OWNER));
    expect(await read()).toMatchObject({ status: 'untrusted_writer', marker: null });
  });

  test('a remote rewrite of an importer page keeps the marker text but loses its trust', async () => {
    await importer(SLUG, page(OWNER));
    const live = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
    await operations.find(o => o.name === 'put_page')!.handler(ctx(true), { slug: SLUG, expected_revision: live!.revision,
      content: page(OWNER, '**User** (2026-01-02T00:00:00Z): I founded acme-example.') });
    expect(await read()).toMatchObject({ status: 'untrusted_writer', marker: null });
  });

  test('a local write without importer provenance on an ordinary source is not honored', async () => {
    await putPage(false, SLUG, page(OWNER));
    expect((await read())!.status).toBe('untrusted_writer');
  });

  test('a connector sync into an iMessage source is honored; the same write into an ordinary source is not', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('texts', 'texts', '{\"kind\":\"imessage\"}'::jsonb)");
    const marker = { label: 'Me', basis: 'is_from_me', turns: 2 };
    await importer('imessage/2026-01-02-example', page(marker), 'texts', null);
    await importer('imessage/2026-01-02-example', page(marker), 'default', null);
    expect((await read('imessage/2026-01-02-example', 'texts'))!.status).toBe('trusted');
    expect((await read('imessage/2026-01-02-example', 'default'))!.status).toBe('untrusted_writer');
  });

  test('an invalid marker is never honored, whoever wrote it', async () => {
    await importer(SLUG, page({ ...OWNER, basis: 'name_match' }));
    expect((await read())!.status).toBe('invalid');
  });

  test('a marker names only the one person the page\'s source belongs to', async () => {
    await addMember(engine, 'alice-example');
    await setOwner(engine, 'alice-example');
    await importer(SLUG, page({ ...OWNER, member: 'alice-example' }));
    expect((await read())!.status).toBe('trusted');
    await importer(SLUG, page(OWNER));
    expect((await read())!.status).toBe('member_mismatch');
    await addMember(engine, 'bob-example');
    for (const member of ['alice-example', 'bob-example']) {
      await importer(SLUG, page({ ...OWNER, member }));
      expect((await read())!.status).toBe('member_mismatch');
    }
    await bindMemberSource(engine, 'bob-example', 'default');
    expect((await read())!.status).toBe('trusted');
    await importer(SLUG, page({ ...OWNER, member: 'alice-example' }));
    expect((await read())!.status).toBe('member_mismatch');
    await bindMemberSource(engine, 'alice-example', 'default');
    expect((await read())!.status).toBe('member_mismatch');
  });

  test('a connector write into a Meetings source is not honored: no meetings importer stamps a marker', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('calls', 'calls', '{\"kind\":\"meetings\"}'::jsonb)");
    await importer('meetings/2026-01-02-example', page({ label: 'Owner Example', basis: 'is_from_me', turns: 1 }), 'calls', null);
    expect((await read('meetings/2026-01-02-example', 'calls'))!.status).toBe('untrusted_writer');
  });

  test('an unjournaled write is honored only under a local principal', async () => {
    await importer(SLUG, page(OWNER));
    expect((await read())!.status).toBe('trusted');
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.write_principal_kind', 'local_stdio', true), set_config('gbrain.write_principal_id', 'stdio:example', true)");
      await tx.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' (edited)' WHERE source_id = 'default' AND slug = $1", [SLUG]);
    });
    const [row] = await engine.executeRaw<{ kind: string | null; req: string | null }>(
      "SELECT revision_principal_kind AS kind, revision_write_request_id::text AS req FROM pages WHERE source_id = 'default' AND slug = $1", [SLUG]);
    expect(row).toEqual({ kind: 'local_stdio', req: null });
    expect((await read())!.status).toBe('untrusted_writer');
  });
});
