/**
 * GST-4037 (review of #10525): a remote rewrite keeps an imported page's first-ingest stamp (#10330), so a later write
 * with no request (maintenance) must never make the page's live revision read as the importer's. The importer-trust
 * checks (the transcript layout and the speaker-owner marker) lean on the stamp only while no later write moved the page
 * past it, and a page with no stamp gets the remote write's own. Repo-less brains; PGLite and (with DATABASE_URL) Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { readSpeakerOwners } from '../src/core/identity/speaker-owner.ts';
import { IMPORTER_INGESTED_VIA, importerWroteLiveRevisionSql } from '../src/core/transcripts/importer-provenance.ts';
import { maintenanceAttribution } from '../src/core/persistence/attribution.ts';
import { withWriteAttribution } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

setDefaultTimeout(60_000);

const SLUG = 'conversations/2026-01-02-claude-code-example';
const OWNER = { label: 'User', basis: 'session_user', turns: 1 };
const page = (body: string) => ['---', 'type: conversation', 'title: Example session', 'date: 2026-01-02',
  'transcript_import: {"of": 2, "part_bytes": 200000}', `speaker_owner: ${JSON.stringify(OWNER)}`, '---', '', body, ''].join('\n');
const BODY = '**User** (2026-01-02T00:00:00Z): hello\n\n**Assistant** (2026-01-02T00:00:01Z): hi';

for (const backend of testBackends()) describe(`[${backend}] importer trust after a remote rewrite and a requestless write (repo-less)`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-4037-trust-'));

  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const pg = new PGLiteEngine(); await pg.connect({ engine: 'pglite' } as never); await pg.initSchema(); engine = pg; close = () => pg.disconnect(); }
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await close?.(); resetGateway(); fs.rmSync(home, { recursive: true, force: true }); }, 60_000);
  beforeEach(async () => { resetGateway(); await disposePersistenceConsumer(engine); await engine.executeRaw('DELETE FROM pages'); });

  const ctx = (): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default' });
  const run = (name: string, params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, () => operations.find(o => o.name === name)!.handler(ctx(), params));
  const revision = async () => (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision;
  const trusted = async () => (await engine.executeRaw<{ trusted: boolean }>(`SELECT ${importerWroteLiveRevisionSql('p', 'r', '$1')} AS trusted
      FROM pages p LEFT JOIN persistence_requests r ON r.id = p.revision_write_request_id WHERE p.source_id = 'default' AND p.slug = $2`,
    [IMPORTER_INGESTED_VIA, SLUG]))[0]!.trusted === true;
  const speaker = async () => (await readSpeakerOwners(engine, [{ source_id: 'default', slug: SLUG }]))[0]!.status;
  /** A write with no request, as maintenance makes one: a tag that moves the live revision. */
  const maintenance = () => withEnv({ GBRAIN_HOME: home }, async () => {
    const attribution = await maintenanceAttribution(engine as never);
    await engine.transaction(tx => withWriteAttribution(tx as never, attribution, () => tx.addTag(SLUG, 'reviewed', { sourceId: 'default' } as never)));
  });
  const imported = () => importFromContent(engine, SLUG, page(BODY), { noEmbed: true, sourceId: 'default', ingested_via: IMPORTER_INGESTED_VIA, source_kind: 'transcript:claude-code' });

  test('an untouched imported page, and a legacy page with no stamp, stay trusted', async () => {
    await imported();
    expect([await trusted(), await speaker()]).toEqual([true, 'trusted']);
    await engine.executeRaw('DELETE FROM pages');
    await engine.putPage(SLUG, { type: 'conversation', title: 'Example session', compiled_truth: BODY, timeline: '', frontmatter: {} } as never);
    expect(await trusted()).toBe(true);
  });

  const rewrites: Array<[string, () => Promise<unknown>]> = [
    ['edit_page', async () => run('edit_page', { slug: SLUG, expected_revision: await revision(), edits: [{ old_text: 'hello', new_text: 'I founded acme-example.' }] })],
    ['put_page', async () => run('put_page', { slug: SLUG, expected_revision: await revision(), content: page(BODY.replace('hello', 'I founded acme-example.')) })],
    ['append_page', async () => run('append_page', { slug: SLUG, expected_revision: await revision(), request_id: crypto.randomUUID(), text: '**User** (2026-01-02T00:00:02Z): I founded acme-example.' })],
  ];
  for (const [op, rewrite] of rewrites) {
    test(`a remote ${op} of an imported page stays untrusted after a later write with no request`, async () => {
      await imported();
      await rewrite();
      expect([await trusted(), await speaker()]).toEqual([false, 'untrusted_writer']);
      await maintenance();
      expect(await engine.executeRaw<{ req: string | null }>('SELECT revision_write_request_id::text AS req FROM pages WHERE slug = $1', [SLUG])).toEqual([{ req: null }]);
      expect([await trusted(), await speaker()]).toEqual([false, 'untrusted_writer']);
    });
  }

  test('a remote edit_page of a page with no stamp stamps its own, so a later write with no request does not vouch for it', async () => {
    await engine.putPage(SLUG, { type: 'conversation', title: 'Example session', compiled_truth: BODY, timeline: '',
      frontmatter: { transcript_import: { of: 2, part_bytes: 200000 } } } as never);
    await run('edit_page', { slug: SLUG, expected_revision: await revision(), edits: [{ old_text: 'hello', new_text: 'I founded acme-example.' }] });
    await maintenance();
    expect(await trusted()).toBe(false);
  });
});
