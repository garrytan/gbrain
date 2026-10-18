/**
 * #6741 C: the managed purge never burns permanent request ids on a tombstone
 * it cannot purge.
 *
 * Protects: (1) a source whose writer is not active is not submitted at all
 * and is reported with its state; (2) a tombstone that fails five times is
 * parked, every attempt having taken its own request id (never reused, so a
 * terminal failed receipt is never replayed); (3) the park rearms once the
 * writer is active again; (4) `gbrain pages purge-deleted --retry-parked`
 * gives a parked page one more attempt through the consent gate, and doctor
 * `purge_parked_pages` names it with a fix that clears it; (5) a background
 * producer (the transcript stale-part delete included) is refused before any
 * receipt against a worktree in recovery (a draining owner still admits and
 * replays; test/persistence-connectors.test.ts keeps that).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeContext } from '../src/cli/main.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { purgeConsentRequest, purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { runPages } from '../src/commands/pages.ts';
import { checkPurgeParkedPages } from '../src/commands/doctor/checks/purge-parks.ts';
import { cliRenderContext, renderAction, type Action } from '../src/core/agent-output.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'purge-parks';
const SLUG = 'notes/expired';
let engine: PGLiteEngine;
let dir: string;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

const env = () => ({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
const logger = { info() {}, warn() {}, error() {} };
const ctxFor = (admissionOrigin?: 'background'): OperationContext => ({ engine, sourceId: SOURCE, remote: false, dryRun: false, logger,
  config: { engine: engine.kind, embedding_disabled: true } as never, ...(admissionOrigin ? { admissionOrigin } : {}) });

beforeEach(async () => {
  _resetCliExitVerdictForTests();
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-purge-parks-'));
  root = join(dir, 'brain');
  mkdirSync(root);
  await withEnv(env(), async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, root]);
    await engine.setConfig('sync.write_through', 'true');
    await claimWorktree(engine, SOURCE, root);
    await submitPageMutation(ctxFor(), { operation: 'put_page', params: { slug: SLUG, content: '---\ntitle: Expired\ntype: note\n---\nGone soon.', request_id: randomUUID() } });
    const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: SOURCE });
    await submitPageMutation(ctxFor(), { operation: 'delete_page', params: { slug: SLUG, expected_revision: snapshot!.revision, request_id: randomUUID() } });
    await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1 AND slug=$2", [SOURCE, SLUG]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  });
});

afterEach(async () => {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('DROP TRIGGER IF EXISTS purge_parks_refuse ON pages');
  rmSync(dir, { recursive: true, force: true });
});

const purge = (opts?: { retryParked?: boolean }) => withEnv(env(), () => purgeDeletedPagesCoordinated(engine, 72, opts));
const purgeRequests = async () => engine.executeRaw<{ request_id: string; state: string }>(
  "SELECT request_id::text, state FROM persistence_requests WHERE source_id=$1 AND operation='delete_page' AND (intent->>'purge')::boolean IS TRUE ORDER BY sequence", [SOURCE]);
const lifetimeIds = async () => Number((await engine.executeRaw<{ n: string }>("SELECT lifetime_ids::text AS n FROM persistence_counters WHERE key='brain'"))[0]?.n ?? 0);
const tombstone = async () => (await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, SLUG])).length > 0;
const setWorktree = (state: 'active' | 'recovering') =>
  engine.executeRaw('UPDATE persistence_worktrees w SET state=$2 FROM persistence_source_bindings b WHERE b.worktree_id=w.id AND b.source_id=$1', [SOURCE, state]);
/** A permanent purge failure: the hard delete of this one page is refused by the database. */
async function refusePurge(): Promise<void> {
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION purge_parks_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic purge refusal'; END $$`);
  await engine.executeRaw(`CREATE TRIGGER purge_parks_refuse BEFORE DELETE ON pages FOR EACH ROW WHEN (OLD.slug = 'notes/expired') EXECUTE FUNCTION purge_parks_refuse()`);
}
const allowPurge = () => engine.executeRaw('DROP TRIGGER IF EXISTS purge_parks_refuse ON pages');
async function parkIt(): Promise<void> {
  await refusePurge();
  for (let attempt = 1; attempt <= 5; attempt++) expect(await purge()).toMatchObject({ count: 0, failed: 1, parked: 0 });
}
async function cli(args: string[]): Promise<string> {
  const out: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  try { await withEnv(env(), () => runPages(engine, args)); } finally { log.mockRestore(); }
  return out.join('\n');
}

describe('#6741 C: the managed purge spends no request ids it cannot use', () => {
  test('a source whose writer is not active is not submitted and is reported with its state', async () => {
    await setWorktree('recovering');
    const before = await lifetimeIds();
    const result = await purge();
    expect(result).toMatchObject({ count: 0, failed: 0, inactive: 1 });
    expect(result.blocked).toEqual([expect.objectContaining({ source_id: SOURCE, slug: SLUG, code: 'writer_not_active', binding_state: 'recovery_required' })]);
    expect(await purgeRequests()).toEqual([]);
    expect(await lifetimeIds()).toBe(before);
    expect(await tombstone()).toBe(true);
  }, 120_000);

  test('a tombstone that fails five times is parked; every attempt took its own request id', async () => {
    await parkIt();
    const attempts = await purgeRequests();
    expect(attempts).toHaveLength(5);
    expect(new Set(attempts.map(a => a.request_id)).size).toBe(5);
    const before = await lifetimeIds();
    const sixth = await purge();
    expect(sixth).toMatchObject({ count: 0, failed: 0, parked: 1 });
    expect(sixth.blocked[0]).toMatchObject({ slug: SLUG, code: 'purge_parked' });
    expect(await purgeRequests()).toHaveLength(5);
    expect(await lifetimeIds()).toBe(before);
  }, 120_000);

  test('the park rearms once the writer is active again', async () => {
    await parkIt();
    await setWorktree('recovering');
    expect(await purge()).toMatchObject({ inactive: 1, parked: 0 });
    await setWorktree('active');
    await allowPurge();
    const before = await lifetimeIds();
    expect(await purge()).toMatchObject({ count: 1, failed: 0, parked: 0 });
    expect(await tombstone()).toBe(false);
    expect(await lifetimeIds()).toBe(before + 1);
  }, 120_000);

  test('--retry-parked gives a parked page exactly one more attempt through the consent gate', async () => {
    await parkIt();
    const consent = purgeConsentRequest(1, 72, true, [], true);
    expect(consent.argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--older-than', '72h', '--retry-parked', '--json', '--yes']);
    expect(consent.preview_argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--older-than', '72h', '--retry-parked', '--dry-run', '--json']);
    const preview = JSON.parse(await cli(['purge-deleted', '--retry-parked', '--dry-run', '--json']));
    expect(preview).toMatchObject({ dry_run: true, count: 1, retry_parked: true, parked: [{ source_id: SOURCE, slug: SLUG, failures: 5 }] });
    expect(await purgeRequests()).toHaveLength(5);
    // Still failing: one more request, and the page stays parked.
    await cli(['purge-deleted', '--retry-parked', '--json', '--yes']);
    expect(await purgeRequests()).toHaveLength(6);
    expect(await purge()).toMatchObject({ parked: 1 });
    expect(await purgeRequests()).toHaveLength(6);
  }, 120_000);

  test('doctor purge_parked_pages names the parked page; its fix clears the finding', async () => {
    expect((await checkPurgeParkedPages(engine)).status).toBe('ok');
    await parkIt();
    const finding = await checkPurgeParkedPages(engine);
    expect(finding).toMatchObject({ name: 'purge_parked_pages', status: 'warn', details: { parked: 1, pages: [{ source_id: SOURCE, slug: SLUG, failures: 5 }] } });
    expect(finding.message).toContain(`${SOURCE}/${SLUG}`);
    const rendered = renderAction(finding.fix as Action, cliRenderContext());
    expect(rendered).toMatchObject({ next: 'ask_user', argv: ['gbrain', 'pages', 'purge-deleted', '--retry-parked', '--yes'],
      verify: { argv: ['gbrain', 'doctor', '--only', 'purge_parked_pages', '--json'] } });
    await allowPurge(); // the cause the last error named is fixed
    await cli(rendered.argv!.slice(2));
    expect(await tombstone()).toBe(false);
    // The verify step: the same check doctor --only purge_parked_pages runs.
    expect(await checkPurgeParkedPages(engine)).toMatchObject({ status: 'ok', details: { parked: 0 } });
  }, 120_000);
});

describe('#6741 C: background admissions refuse before any receipt against a worktree in recovery', () => {
  test('a background put_page is refused owner_unavailable with the owner-status read fix and takes no request id', async () => {
    await setWorktree('recovering');
    const before = await lifetimeIds();
    const requests = (await engine.executeRaw('SELECT 1 FROM persistence_requests')).length;
    await expect(withEnv(env(), () => submitPageMutation(ctxFor('background'), { operation: 'put_page',
      params: { slug: 'notes/background', content: '---\ntitle: Background\ntype: note\n---\nMaintenance output.', request_id: randomUUID() } })))
      .rejects.toMatchObject({ code: 'owner_unavailable', fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', SOURCE, '--json'] } });
    expect(await lifetimeIds()).toBe(before);
    expect((await engine.executeRaw('SELECT 1 FROM persistence_requests')).length).toBe(requests);
  }, 120_000);

  test('the transcript stale-part delete is a background admission: refused, no request id, the session errors', async () => {
    const message = (role: string, t: number, text: string) => ({ author: { role }, create_time: t, content: { content_type: 'text', parts: [text] } });
    const path = join(dir, 'export.json');
    writeFileSync(path, JSON.stringify([{ title: 'Stale parts', create_time: 1786080000, update_time: 1786080015, conversation_id: 'cgpt-stale-1', current_node: 'n2',
      mapping: { root: { id: 'root', parent: null, children: ['n1'], message: null },
        n1: { id: 'n1', parent: 'root', children: ['n2'], message: message('user', 1786080005, 'A question.') },
        n2: { id: 'n2', parent: 'n1', children: [], message: message('assistant', 1786080015, 'An answer.') } } }]));
    const ingest = () => withEnv(env(), async () => runTranscriptsIngest(engine, { paths: [path], sourceId: SOURCE, format: 'chatgpt',
      context: await makeContext(engine, { source: SOURCE, dry_run: false }) }));
    expect((await ingest()).pages).toMatchObject({ imported: 1, errored: 0 });
    const [{ slug }] = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'conversations/%'", [SOURCE]);
    await withEnv(env(), () => submitPageMutation(ctxFor(), { operation: 'put_page',
      params: { slug: `${slug}-p2`, content: '---\ntitle: Stale part\ntype: note\n---\nLeft behind by a re-split.', request_id: randomUUID() } }));
    await setWorktree('recovering');
    const before = await lifetimeIds();
    const result = await ingest();
    expect(result).toMatchObject({ partsDeleted: 0, sessionsErrored: 1, cleanScan: false });
    expect(result.files[0]!.sessions[0]!.error).toContain('paused');
    expect(await lifetimeIds()).toBe(before);
    expect((await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND operation='delete_page' AND slug=$2", [SOURCE, `${slug}-p2`])).length).toBe(0);
  }, 120_000);
});
