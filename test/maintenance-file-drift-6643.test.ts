/**
 * #6643: the source_changed conflict pile becomes visible (B0), stops growing (B1),
 * resolvable (B2) and measured (B3).
 *
 * A canonical file that diverged from its database row refuses every coordinated
 * write. Before #6643 `synthesize_concepts` paid for a narrative per drifted
 * concept on every cycle and left a conflict receipt for each publication, and no
 * command resolved the pile. These cases pin:
 *   - B1: a drifted concept is skipped before any provider call or admission, on
 *     every cycle (restart-safe: the check is live), the skip is recorded in
 *     `dream.concepts.drift_skips` and released once the file and database agree;
 *     a maintenance submit refuses `source_changed` / `file_database_drift`
 *     without a request row, while a replay of an earlier request returns its receipt;
 *   - B0: the conflict audit groups receipts by slug with the live check for the
 *     trusted CLI and database-derived fields only for scoped MCP readers;
 *   - B2: `gbrain repair file-drift` previews, refuses mixed drift classes under
 *     --all-drifted unless --class keeps one, applies exactly the previewed set
 *     with per-page outcomes and resumes an interrupted apply; --prefer keeps
 *     one-sided metadata, tags and protected metadata as reconcile protects them;
 *   - B3: doctor `maintenance_write_drift` counts drifted pages and skips.
 *
 * Runs on PGLite, and on Postgres when DATABASE_URL is set
 * (test/e2e/maintenance-file-drift-6643-postgres.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { maintenancePreflight, publishMaintenancePage } from '../src/core/persistence/prepared-maintenance.ts';
import { DRIFT_SKIPS_KEY, liveFileDrift, readDriftSkips, recordDriftSkip, releaseDriftSkip } from '../src/core/persistence/drift-conflicts.ts';
import { runReconcileAudit } from '../src/core/persistence/reconcile-audit.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { persistenceOperations } from '../src/core/ops/persistence.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { preferSideDecisions, driftExceptions } from '../src/core/repair/file-drift.ts';
import { maintenanceWriteDriftCheck } from '../src/commands/doctor/checks/maintenance-drift.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };
const CONCEPT = 'concepts/example-topic';
const listConflicts = persistenceOperations.find(op => op.name === 'list_write_conflicts')!;

function conceptMarkdown(narrative: string, hash: string): string {
  return `---\ntype: concept\ntitle: example topic\nsynthesized_by: synthesize_concepts-v0.41\nsynthesis_mode: llm\nmember_hash: ${hash}\nvisibility: world\ntier: T2\n---\n\n${narrative}\n`;
}
const atoms = (variant: string) => Array.from({ length: 5 }, (_, i) => ({ slug: `atoms/example-${i}`, title: `Example ${i}`,
  body: `Observation ${i} ${variant}.`, concept_refs: ['example-topic'], visibility: 'world' as const }));

for (const backend of testBackends()) describe(`#6643 maintenance file drift (${backend})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-6643-db-'));

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    if (backend === 'pglite') {
      const pglite = new PGLiteEngine();
      await pglite.connect({ database_path: dataDir }); await pglite.initSchema(); engine = pglite;
    } else {
      const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      engine = pg.engine; closePostgres = pg.close;
    }
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
    resetGateway(); rmSync(dataDir, { recursive: true, force: true });
  });

  async function fixture(run: (input: { root: string; sourceId: string; ctx: OperationContext }) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-6643-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `d6643-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        await run({ root, sourceId, ctx });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.unsetConfig(DRIFT_SKIPS_KEY);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const put = (ctx: OperationContext, slug: string, content: string) =>
    submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID() } });
  const requests = async (sourceId: string) => Number((await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1', [sourceId]))[0].n);

  test('a drifted concept is skipped before spend and admission on every cycle, and released after --prefer file', () => fixture(async ({ root, sourceId, ctx }) => {
    for (const atom of atoms('one')) await put(ctx, atom.slug, `---\ntype: atom\ntitle: ${atom.title}\n---\n${atom.body}\n`);
    await put(ctx, CONCEPT, conceptMarkdown('The first narrative.', 'stale-hash'));
    const file = join(root, 'concepts', 'example-topic.md');
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, readFileSync(file, 'utf8').replace('The first narrative.', 'The first narrative.\n\nA paragraph added in the file only.'));
    const drifted = readFileSync(file, 'utf8');
    expect((await liveFileDrift(engine, sourceId, CONCEPT)).still_present).toBe(true);

    let calls = 0;
    const chat = (async () => { calls++; return { text: 'A paid narrative.', usage: { input_tokens: 10, output_tokens: 10 }, model: 'anthropic:claude-sonnet-4-6', stopReason: 'end' }; }) as never;
    const before = await requests(sourceId);
    for (const cycle of [1, 2]) {
      const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(`cycle-${cycle}`), sourceId, brainDir: root, _chat: chat });
      const details = result.details as Record<string, unknown>;
      expect(details.skipped_file_drift).toEqual([CONCEPT]);
      expect(result.status).toBe('warn');
      expect(result.summary).toContain('gbrain repair file-drift');
      expect(result.summary).toContain('--audit --conflicts');
    }
    expect(calls).toBe(0);
    expect(await requests(sourceId)).toBe(before);
    const skips = await readDriftSkips(engine);
    expect(skips[`${sourceId}:${CONCEPT}`]).toMatchObject({ db_revision: expect.any(String), file_hash: expect.any(String) });

    const doctor = await maintenanceWriteDriftCheck(engine, [sourceId]);
    expect(doctor).toMatchObject({ name: 'maintenance_write_drift', status: 'warn', details: { count: 1, concept_skips: 1 } });
    expect(doctor.fix?.argv).toEqual(['gbrain', 'sources', 'reconcile', sourceId, '--brain', 'host', '--audit', '--conflicts', '--json']);

    const scope = await resolveRepairScope(engine, sourceId);
    const preview = await (await repairRunner(engine, { apply: false, logger })).run('file-drift', scope,
      { explicit: true, sourceFlag: sourceId, slugs: [CONCEPT], prefer: 'file' });
    const hash = preview.preview_hash!;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview).toMatchObject({ mode: 'dry_run', affected: 1 });
    expect(preview.apply_command).toContain(`--slug ${CONCEPT}`);
    expect(preview.apply_command).toContain('--prefer file');
    const applied = await (await repairRunner(engine, { apply: true, logger })).run('file-drift', scope,
      { explicit: true, sourceFlag: sourceId, slugs: [CONCEPT], prefer: 'file', expect: hash });
    expect(applied.outcomes).toEqual({ repaired: 1 });
    expect(readFileSync(file, 'utf8')).toBe(drifted);
    expect((await liveFileDrift(engine, sourceId, CONCEPT)).still_present).toBe(false);
    expect((await engine.getPage(CONCEPT, { sourceId }))!.compiled_truth).toContain('A paragraph added in the file only.');

    const released = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms('cycle-3'), sourceId, brainDir: root, _chat: chat });
    expect((released.details as Record<string, unknown>).skipped_file_drift).toEqual([]);
    expect(calls).toBe(1);
    expect((await readDriftSkips(engine))[`${sourceId}:${CONCEPT}`]).toBeUndefined();
    expect((await maintenanceWriteDriftCheck(engine, [sourceId])).status).toBe('ok');
  }), 240_000);

  const drift = (root: string, slug: string, edit: (text: string) => string) => {
    const file = join(root, `${slug}.md`);
    writeFileSync(file, edit(readFileSync(file, 'utf8')));
    return file;
  };
  /** A caller write refused source_changed: one conflict receipt for the slug. */
  const refusedWrite = async (ctx: OperationContext, slug: string, body: string) => {
    const expected_revision = (await engine.readPageSnapshot(slug, { sourceId: ctx.sourceId! }))!.revision;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: `---\ntype: note\ntitle: Refused\n---\n${body}\n`, expected_revision, request_id: randomUUID() } })
      .then(() => { throw new Error(`write to ${slug} committed`); }, (error: { code?: string }) => expect(error.code).toBe('source_changed'));
  };

  test('a maintenance submit refuses drift before admission, and a replay of an earlier request still returns its receipt', () => fixture(async ({ root, sourceId, ctx }) => {
    await put(ctx, CONCEPT, conceptMarkdown('The first narrative.', 'h1'));
    const authority = (await maintenancePreflight(engine, sourceId, root))!;
    const snapshot = (await engine.readPageSnapshot(CONCEPT, { sourceId }))!;
    const content = conceptMarkdown('A maintenance narrative.', 'h2');
    const first = await publishMaintenancePage(engine, authority, CONCEPT, content, { expectedRevision: snapshot.revision });
    expect(first.state).toBe('committed');
    drift(root, CONCEPT, text => `${text}\nA hand edit.\n`);
    const before = await requests(sourceId);
    const replay = await publishMaintenancePage(engine, authority, CONCEPT, content, { expectedRevision: snapshot.revision });
    expect(replay.request_id).toBe(first.request_id);
    const current = (await engine.readPageSnapshot(CONCEPT, { sourceId }))!;
    const refused = await publishMaintenancePage(engine, authority, CONCEPT, conceptMarkdown('Another narrative.', 'h3'), { expectedRevision: current.revision })
      .then(() => null, (error: { code?: string; detail?: string; suggestion?: string }) => error);
    expect(refused).toMatchObject({ code: 'source_changed', detail: 'file_database_drift' });
    expect(refused!.suggestion).toContain('--audit --conflicts');
    expect(refused!.suggestion).toContain('gbrain repair file-drift');
    expect(await requests(sourceId)).toBe(before);
  }), 240_000);

  test('the conflict audit groups receipts by slug; scoped MCP readers get database-derived fields within their grant', () => fixture(async ({ root, sourceId, ctx }) => {
    await put(ctx, 'notes/alpha', '---\ntype: note\ntitle: Alpha\n---\nAlpha.\n');
    await put(ctx, 'notes/secret', '---\ntype: note\ntitle: Secret\nvisibility: private\n---\nSecret.\n');
    await put(ctx, 'people/alice-example', '---\ntype: person\ntitle: Alice Example\n---\nAlice.\n');
    for (const slug of ['notes/alpha', 'notes/secret', 'people/alice-example']) drift(root, slug, text => `${text}\nEdited in the file only.\n`);
    await refusedWrite(ctx, 'notes/alpha', 'One.');
    await refusedWrite(ctx, 'notes/alpha', 'Two.');
    await refusedWrite(ctx, 'notes/secret', 'Three.');
    await refusedWrite(ctx, 'people/alice-example', 'Four.');

    const report = await runReconcileAudit(engine, { source_id: sourceId, conflicts: true });
    expect(report).toMatchObject({ source_id: sourceId, group_by: 'slug', complete: true, next: null, totals: { slugs: 3, receipts: 4, still_present: 3, checked: 3 } });
    expect(report.conflicts.map(row => [row.slug, row.receipts, row.drift_receipts])).toEqual([['notes/alpha', 2, 2], ['notes/secret', 1, 1], ['people/alice-example', 1, 1]]);
    const alpha = report.conflicts[0];
    expect(alpha).toMatchObject({ producers: ['put_page'], still_present: { value: true, reason: 'file_database_drift' }, source_path: 'notes/alpha.md',
      git: { tracked: false, committed: false }, class: 'additive_with_suggestions', last_committed: { request_id: expect.any(String) },
      last_conflict_request_id: expect.any(String), file_hash: expect.any(String), db_revision: expect.any(String) });
    const paged = await runReconcileAudit(engine, { source_id: sourceId, conflicts: true, limit: 1 });
    expect(paged).toMatchObject({ complete: false });
    expect(paged.conflicts.map(row => row.slug)).toEqual(['notes/alpha']);
    const next = await runReconcileAudit(engine, { source_id: sourceId, conflicts: true, limit: 1, after: paged.next! });
    expect(next.conflicts.map(row => row.slug)).toEqual(['notes/secret']);

    const remote = (auth: Record<string, unknown>) => ({ engine, remote: true, sourceId, logger, config: { engine: engine.kind } as never,
      auth: { token: 't', clientId: 'reader-example', scopes: ['read'], ...auth } } as unknown as OperationContext);
    const reader = await listConflicts.handler(remote({}), { source_id: sourceId }) as { conflicts: Array<Record<string, unknown>>; totals: Record<string, number> };
    expect(reader.conflicts.map(row => row.slug)).toEqual(['notes/alpha', 'people/alice-example']);
    expect(reader.totals).toMatchObject({ slugs: 2, receipts: 3, checked: 0 });
    for (const row of reader.conflicts) {
      expect(row.still_present).toEqual({ value: null, reason: 'remote_caller' });
      for (const key of ['source_path', 'git', 'file_hash', 'db_revision', 'class', 'last_conflict_request_id']) expect(row).not.toHaveProperty(key);
      expect(row.last_committed).not.toHaveProperty('request_id');
    }
    expect(JSON.stringify(reader)).not.toContain(root);
    const fenced = await listConflicts.handler(remote({ boundSlugPrefixes: ['people/'] }), { source_id: sourceId }) as { conflicts: Array<{ slug: string }> };
    expect(fenced.conflicts.map(row => row.slug)).toEqual(['people/alice-example']);
    // A source outside the grant is refused like every source-scoped read, the same whether it exists or not (no existence oracle).
    for (const named of [sourceId, 'unregistered-example']) {
      await expect(listConflicts.handler(remote({ allowedSources: ['other-source'] }), { source_id: named })).rejects.toMatchObject({ code: 'permission_denied' });
    }
    // The window is bounded by this source's own requests: writes in another source do not move it.
    const before = await listConflicts.handler(remote({}), { source_id: sourceId }) as { window: Record<string, unknown>; next: string | null };
    const other = `d6643-other-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [other, join(root, '..', 'other')]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,intent_bytes,terminal_reservation,state)
      SELECT 'local_cli','other',gen_random_uuid(),'put_page',$1,(SELECT incarnation FROM sources WHERE id=$1),'notes/n-'||g,'d','{}'::jsonb,'{}'::jsonb,1,16384,'committed'
      FROM generate_series(1,5) g`, [other]);
    const [{ top }] = await engine.executeRaw<{ top: string }>('SELECT max(sequence)::text AS top FROM persistence_requests');
    const after = await listConflicts.handler(remote({}), { source_id: sourceId }) as { window: Record<string, unknown> };
    expect(after.window).toEqual(before.window);
    expect(after.window.through_sequence).not.toBe(top);
    // A cursor naming a later sequence is clamped to the source's own newest request.
    const forged = await listConflicts.handler(remote({}), { source_id: sourceId, cursor: `${top}:` }) as { window: Record<string, unknown> };
    expect(forged.window.through_sequence).toBe(before.window.through_sequence);
  }), 240_000);

  test('--all-drifted refuses mixed drift classes unless --class keeps one', () => fixture(async ({ root, sourceId, ctx }) => {
    await put(ctx, 'notes/additive', '---\ntype: note\ntitle: Additive\n---\nAdditive.\n');
    await put(ctx, 'notes/rewritten', '---\ntype: note\ntitle: Rewritten\n---\nOriginal sentence.\n');
    drift(root, 'notes/additive', text => `${text}\nAn appended line.\n`);
    drift(root, 'notes/rewritten', text => text.replace('Original sentence.', 'A different sentence.'));
    await refusedWrite(ctx, 'notes/additive', 'One.');
    await refusedWrite(ctx, 'notes/rewritten', 'Two.');
    const scope = await resolveRepairScope(engine, sourceId);
    const runner = await repairRunner(engine, { apply: false, logger });
    const surveyed = await runner.run('file-drift', await resolveRepairScope(engine, undefined), { explicit: true });
    expect(surveyed.affected).toBe(0);
    expect(surveyed.preview_hash).toBeUndefined();
    expect(surveyed.listing!.filter(row => row.item.startsWith(`${sourceId}:`)).map(row => [row.item, row.class]))
      .toEqual([[`${sourceId}:notes/additive`, 'additive_with_suggestions'], [`${sourceId}:notes/rewritten`, 'review_required']]);
    expect(surveyed.details!.next_actions).toContain(`Preview: gbrain repair file-drift --source ${sourceId} --all-drifted --class review_required --prefer file (or --prefer database)`);
    const mixed = await runner.run('file-drift', scope, { explicit: true, sourceFlag: sourceId, allDrifted: true, prefer: 'file' }).then(() => null, error => error);
    expect(mixed).toMatchObject({ code: 'invalid_params' });
    expect(mixed.message).toContain('2 drift classes');
    expect(mixed.message).toContain('review_required=1');
    expect(mixed.message).toContain('additive_with_suggestions=1');
    const one = await runner.run('file-drift', scope, { explicit: true, sourceFlag: sourceId, allDrifted: true, driftClass: 'review_required', prefer: 'file' });
    expect(one.affected).toBe(1);
    expect(one.sample).toEqual([`${sourceId}:notes/rewritten`]);
    expect(one.apply_command).toContain('--all-drifted --class review_required --prefer file');
  }), 240_000);

  test('--prefer keeps protected metadata and unions tags; an interrupted apply resumes, and a page edited after the preview is changed_since_preview', () => fixture(async ({ root, sourceId, ctx }) => {
    await put(ctx, 'notes/one', '---\ntype: note\ntitle: One\nreviewed: true\ntags: [alpha]\n---\nStored one.\n');
    await put(ctx, 'notes/two', '---\ntype: note\ntitle: Two\n---\nStored two.\n');
    await put(ctx, 'notes/three', '---\ntype: note\ntitle: Three\n---\nStored three.\n');
    const stored = (await engine.readPageSnapshot('notes/one', { sourceId }))!;
    drift(root, 'notes/one', text => text.replace('reviewed: true\n', 'owner: alice-example\n').replace('Stored one.', 'File one.')
      .replace(/ingested_via: [^\n]+/, 'ingested_via: hand-edit').replace('  - alpha', '  - alpha\n  - beta'));
    drift(root, 'notes/two', text => text.replace('Stored two.', 'File two.'));
    drift(root, 'notes/three', text => text.replace('Stored three.', 'File three.'));
    const scope = await resolveRepairScope(engine, sourceId);
    const slugs = ['notes/one', 'notes/two', 'notes/three'];
    const preview = await (await repairRunner(engine, { apply: false, logger })).run('file-drift', scope, { explicit: true, sourceFlag: sourceId, slugs, prefer: 'database' });
    const hash = preview.preview_hash!;
    expect(preview.affected).toBe(3);
    const pages = (preview.details!.pages as Array<{ slug: string; exceptions: Array<{ path: string; reason: string }> }>);
    expect(pages.find(page => page.slug === 'notes/one')!.exceptions).toEqual([{ path: '/tags', reason: 'tags_union' }]);
    const artifact = JSON.parse(readFileSync(String(preview.details!.artifact), 'utf8'));
    const one = artifact.pages.find((page: { slug: string }) => page.slug === 'notes/one');
    expect(one.result.frontmatter).toMatchObject({ reviewed: true, ingested_via: stored.page.frontmatter.ingested_via ?? 'put_page' });
    expect(one.result.frontmatter).not.toHaveProperty('owner');
    expect(one.result.tags).toEqual(['alpha', 'beta']);
    expect(one.result.compiled_truth).toBe('Stored one.');

    const apply = (limit?: number) => repairRunner(engine, { apply: true, logger }).then(runner => runner.run('file-drift', scope,
      { explicit: true, sourceFlag: sourceId, slugs, prefer: 'database', expect: hash, ...(limit ? { limit } : {}) }));
    const firstRun = await apply(1);
    expect(firstRun).toMatchObject({ applied: 1, complete: false, outcomes: { repaired: 1 } });
    drift(root, 'notes/two', text => text.replace('File two.', 'File two, edited again.'));
    const resumed = await apply();
    expect(resumed.resumed_from).not.toBeNull();
    expect(resumed.outcomes).toEqual({ changed_since_preview: 1, repaired: 1 });
    expect(resumed.outcome_items!.map(item => [item.item, item.outcome])).toEqual([[`${sourceId}:notes/three`, 'repaired'], [`${sourceId}:notes/two`, 'changed_since_preview']]);
    const page = (await engine.getPage('notes/one', { sourceId }))!;
    expect(page.compiled_truth).toBe('Stored one.');
    expect(page.frontmatter).toMatchObject({ reviewed: true });
    expect(await engine.getTags('notes/one', { sourceId })).toEqual(['alpha', 'beta']);
    expect(readFileSync(join(root, 'notes/one.md'), 'utf8')).not.toContain('owner: alice-example');
    expect((await liveFileDrift(engine, sourceId, 'notes/two')).still_present).toBe(true);
    await expect(apply()).rejects.toMatchObject({ code: 'preview_changed' });
  }), 240_000);
});

describe('#6643 file-drift pure rules', () => {
  const page = (fields: Partial<{ title: string; compiled_truth: string; frontmatter: Record<string, unknown>; tags: string[] }>) =>
    ({ type: 'note', title: 'T', compiled_truth: 'Body.', timeline: '', frontmatter: {}, tags: [], ...fields }) as never;
  test('prefer decisions take the preferred side, drop its missing keys and never decide protected keys or tags', () => {
    const file = page({ compiled_truth: 'File.', frontmatter: { owner: 'alice-example', provenance: 'hand', shared: 1 }, tags: ['b'] });
    const database = page({ frontmatter: { reviewed: true, provenance: 'extracted', shared: 1 }, tags: ['a'] });
    expect(preferSideDecisions(file, database, 'file')).toEqual([{ path: '/compiled_truth', action: 'take_file' },
      { path: '/frontmatter/owner', action: 'take_file' }, { path: '/frontmatter/reviewed', action: 'delete' }]);
    expect(preferSideDecisions(file, database, 'database')).toEqual([{ path: '/compiled_truth', action: 'take_database' },
      { path: '/frontmatter/owner', action: 'delete' }, { path: '/frontmatter/reviewed', action: 'take_database' }]);
  });
  test('exceptions name the protection that kept each difference', () => {
    const preferred = page({ compiled_truth: 'File.', frontmatter: { provenance: 'hand', atoms_scan_hash: 'x' }, tags: ['b'] });
    const result = page({ compiled_truth: 'File.\n\nkept private row', frontmatter: { provenance: 'extracted' }, tags: ['a', 'b'] });
    expect(driftExceptions(result, preferred)).toEqual([{ path: '/compiled_truth', reason: 'protected_takes_or_private_facts' },
      { path: '/tags', reason: 'tags_union' }, { path: '/frontmatter/atoms_scan_hash', reason: 'scan_state' }, { path: '/frontmatter/provenance', reason: 'protected_metadata' }]);
  });
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  test('drift skip entries update one key at a time and a malformed value is replaced', async () => {
    await Promise.all([recordDriftSkip(engine, 's', 'concepts/a', { file_hash: 'f1', db_revision: 'r1' }),
      recordDriftSkip(engine, 's', 'concepts/b', { file_hash: 'f2', db_revision: 'r2' })]);
    expect(Object.keys(await readDriftSkips(engine)).sort()).toEqual(['s:concepts/a', 's:concepts/b']);
    await releaseDriftSkip(engine, 's', 'concepts/a');
    expect(Object.keys(await readDriftSkips(engine))).toEqual(['s:concepts/b']);
    await engine.setConfig(DRIFT_SKIPS_KEY, 'not json');
    await recordDriftSkip(engine, 's', 'concepts/c', { file_hash: null, db_revision: 'r3' });
    expect(Object.keys(await readDriftSkips(engine))).toEqual(['s:concepts/c']);
  });
});
