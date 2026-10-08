/**
 * Engine-parametrized scenarios for managed capacity (#5470), effect parking
 * (#5612) and coordinated stale extraction (#5609). PGLite runs them from
 * test/; test/e2e/ runs the same bodies on Postgres.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { retryParkedEffects, retryRequestEffects } from '../../src/core/persistence/effect-retry.ts';
import { compactWriteReceipts } from '../../src/core/persistence/journal.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './write-attribution.ts';
import { acquireWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import { computeRecommendations } from '../../src/core/brain-score-recommendations.ts';
import { staleExtractionBlocked } from '../../src/core/remediation/context.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../src/core/link-extraction.ts';
import { checkParkedEffects } from '../../src/commands/doctor/checks/parked-effects.ts';
import { checkPersistenceCapacity } from '../../src/commands/doctor/checks/persistence-capacity.ts';
import { managedBrain } from './managed-brain.ts';
import { durableGitRepo, git } from './git-publication.ts';

const put = (ctx: OperationContext, slug: string, body: string, type = 'note') => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: ${type}\ntitle: ${slug}\n---\n\n${body}\n` } });
type GitEffect = { id: number; request_id: string; state: string; error_code: string | null; attempts: number; data: Record<string, unknown> };
const gitEffect = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<GitEffect>(`SELECT e.id,r.request_id::text AS request_id,e.state,
  e.error_code,e.attempts,e.data FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' AND r.slug=$1`, [slug]))[0];
/** Stops the resident consumer and puts one effect back to a fresh queued state with the given data. */
async function resetEffect(engine: BrainEngine, id: number, data: Record<string, unknown>) {
  await disposePersistenceConsumer(engine);
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw(`UPDATE persistence_effects SET data=$2::text::jsonb,state='queued',attempts=0,execution_token=NULL,
      claim_expires_at=NULL,error_code=NULL,outcome=NULL WHERE id=$1`, [id, JSON.stringify(data)]);
  });
}
/** Runs one effect attempt at a time with every other effect deferred. */
async function runOnly(engine: BrainEngine, ctx: OperationContext, id: number, times = 1) {
  await disposePersistenceConsumer(engine);
  for (let i = 0; i < times; i++) {
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_effects SET next_attempt_at=CASE WHEN id=$1 THEN now() ELSE now()+interval '1 hour' END", [id]);
    });
    await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 1 });
  }
}
const ignoredPages = (root: string) => { writeFileSync(join(root, '.gitignore'), 'aa/\n'); durableGitRepo(root, ['.gitignore']); };
const unignore = (root: string) => { writeFileSync(join(root, '.gitignore'), '\n'); git(root, 'commit', '-q', '-am', 'Stop ignoring aa/'); };
const committed = (root: string) => git(root, 'log', '--name-only', '--pretty=format:');

export async function singleTargetParksAndRetries(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, 'aa/page', 'Ignored by Git.');
    const effect = await gitEffect(engine, 'aa/page');
    await resetEffect(engine, effect.id, { slug: 'aa/page', page_id: effect.data.page_id, relative_path: effect.data.relative_path, expected_hash: effect.data.expected_hash });
    await runOnly(engine, ctx, effect.id, 4);
    expect(await gitEffect(engine, 'aa/page')).toMatchObject({ state: 'queued', error_code: 'git_target_unsafe', data: { target_failures: 4 } });
    await runOnly(engine, ctx, effect.id);
    expect(await gitEffect(engine, 'aa/page')).toMatchObject({ state: 'failed', error_code: 'targets_parked',
      data: { parked: [{ slug: 'aa/page', error_code: 'git_target_unsafe' }] } });
    await runOnly(engine, ctx, effect.id, 3);
    expect((await gitEffect(engine, 'aa/page')).attempts).toBe(5);

    const doctor = await checkParkedEffects(engine);
    expect(doctor).toMatchObject({ status: 'warn', details: { parked_effects: 1, exact: true, truncated: false } });
    expect(doctor.message).toContain(`gbrain sources writer retry-effects default --request-id ${effect.request_id} --dry-run`);
    expect(doctor.message).toContain('aa/page (git_target_unsafe)');

    unignore(root);
    expect(await retryParkedEffects(engine, 'default', effect.request_id, true)).toMatchObject({ dry_run: true,
      effects: [{ kind: 'git', parked_targets: 1, state: 'parked', action: 'would_retry' }] });
    expect(await gitEffect(engine, 'aa/page')).toMatchObject({ state: 'failed', error_code: 'targets_parked' });
    expect(await retryParkedEffects(engine, 'default', effect.request_id, false)).toMatchObject({
      effects: [{ kind: 'git', state: 'queued', terminal: false, action: 'retry_queued' }] });
    await runOnly(engine, ctx, effect.id);
    expect(await gitEffect(engine, 'aa/page')).toMatchObject({ state: 'committed', error_code: null });
    expect(committed(root)).toContain('aa/page.md');
    expect(await retryParkedEffects(engine, 'default', effect.request_id, true)).toMatchObject({
      effects: [{ kind: 'git', state: 'committed', terminal: true, action: 'unchanged', retried: 1 }] });
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_effects SET state='failed',error_code='embedding_attempts_exhausted' WHERE kind='embedding' AND request_id=(SELECT request_id FROM persistence_effects WHERE id=$1)", [effect.id]);
    });
    expect(await retryRequestEffects(engine, 'default', effect.request_id, true, ctx.config)).toMatchObject({ kind: 'embedding',
      parked_effects: [{ kind: 'git', state: 'committed', terminal: true }] });
    expect(await checkParkedEffects(engine)).toMatchObject({ status: 'ok', details: { parked_effects: 0 } });
  }, { databaseUrl, setup: ({ root }) => ignoredPages(root) });
}

export async function scanParksOneTargetAndContinues(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    for (const slug of ['aa/page', 'bb', 'cc']) await put(ctx, slug, `Body of ${slug}.`);
    const scan = await gitEffect(engine, 'bb');
    await resetEffect(engine, scan.id, { source_scan: true });
    await runOnly(engine, ctx, scan.id, 5);
    expect(await gitEffect(engine, 'bb')).toMatchObject({ state: 'queued', data: { after_slug: 'aa/page',
      parked: [{ slug: 'aa/page', error_code: 'git_target_unsafe' }] } });
    await runOnly(engine, ctx, scan.id, 3);
    expect(await gitEffect(engine, 'bb')).toMatchObject({ state: 'failed', error_code: 'targets_parked', data: { after_slug: 'cc' } });
    expect(committed(root)).toContain('cc.md');
    expect(committed(root)).not.toContain('aa/page.md');

    unignore(root);
    await retryParkedEffects(engine, 'default', scan.request_id, false);
    expect((await gitEffect(engine, 'bb')).data).toMatchObject({ retry_slugs: ['aa/page'], target_failures: 4 });
    await runOnly(engine, ctx, scan.id, 2);
    expect(await gitEffect(engine, 'bb')).toMatchObject({ state: 'committed', error_code: null });
    expect(committed(root)).toContain('aa/page.md');
  }, { databaseUrl, setup: ({ root }) => ignoredPages(root) });
}

export async function failuresDoNotCarryToAnotherTarget(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    for (const slug of ['aa/first', 'aa/second', 'cc']) await put(ctx, slug, `Body of ${slug}.`);
    const scan = await gitEffect(engine, 'cc');
    await resetEffect(engine, scan.id, { source_scan: true });
    await runOnly(engine, ctx, scan.id, 4);
    expect((await gitEffect(engine, 'cc')).data).toMatchObject({ target_failures: 4, failing_target: 'aa/first' });
    const first = (await engine.readPageSnapshot('aa/first', { sourceId: 'default' }))!;
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'aa/first', request_id: randomUUID(), expected_revision: first.revision, purge: true } });
    await runOnly(engine, ctx, scan.id);
    expect(await gitEffect(engine, 'cc')).toMatchObject({ state: 'queued', error_code: 'git_target_unsafe',
      data: { target_failures: 1, failing_target: 'aa/second' } });
    expect((await gitEffect(engine, 'cc')).data.parked).toBeUndefined();
  }, { databaseUrl, setup: ({ root }) => ignoredPages(root) });
}

export async function healthyScanAndContentionNeverPark(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slugs = Array.from({ length: 8 }, (_, i) => `notes/page-${i}`);
    for (const slug of slugs) await put(ctx, slug, `Body ${slug}.`);
    const scan = await gitEffect(engine, slugs[0]);
    await resetEffect(engine, scan.id, { source_scan: true });
    const lock = await acquireWorktree((await getWorktreeBinding(engine, 'default', localHostId()))!);
    try { await runOnly(engine, ctx, scan.id, 7); }
    finally { await lock!.release(); }
    const busy = await gitEffect(engine, slugs[0]);
    expect(busy).toMatchObject({ state: 'queued', error_code: 'writer_busy' });
    expect(busy.data.target_failures).toBeUndefined();
    await runOnly(engine, ctx, scan.id, slugs.length + 1);
    const done = await gitEffect(engine, slugs[0]);
    expect(done).toMatchObject({ state: 'committed', error_code: null });
    expect(done.attempts).toBeGreaterThan(slugs.length);
    expect(done.data.parked).toBeUndefined();
    for (const slug of slugs) expect(committed(root)).toContain(`${slug}.md`);
  }, { databaseUrl, setup: ({ root }) => ignoredPages(root) });
}

export async function compactionSkipsUnfinishedReceipts(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    for (let i = 0; i < 102; i++) await put(ctx, `notes/receipt-${i}`, `Receipt ${i}.`);
    await disposePersistenceConsumer(engine);
    const [last] = await engine.executeRaw<{ id: string }>("SELECT id FROM persistence_requests WHERE slug='notes/receipt-101'");
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_effects SET state=CASE WHEN request_id=$1::uuid THEN 'committed' ELSE 'failed' END,error_code=NULL", [last.id]);
    });
    await engine.setConfig('persistence.receipt_retention_days', '0');
    expect(await compactWriteReceipts(engine)).toBe(1);
    expect(await engine.executeRaw('SELECT slug FROM persistence_requests WHERE compacted ORDER BY sequence')).toEqual([{ slug: 'notes/receipt-101' }]);
  }, { databaseUrl });
}

export async function capacityWarnsAndRefusalNamesTheKey(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    expect(await checkPersistenceCapacity(engine)).toMatchObject({ status: 'ok', details: { exact: true, truncated: false } });
    for (let i = 0; i < 8; i++) await put(ctx, `notes/cap-${i}`, `Cap ${i}.`);
    await engine.setConfig('persistence.limits.principal_outstanding', '10');
    expect((await checkPersistenceCapacity(engine)).status).toBe('ok');
    await engine.setConfig('persistence.limits.principal_lifetime_ids', '10');
    const warning = await checkPersistenceCapacity(engine);
    expect(warning.status).toBe('warn');
    const details = warning.details as { resources: Array<{ scope: string; resource: string; used: number; limit: number }>; commands: string[] };
    expect(details.resources).toHaveLength(1);
    expect(details.resources[0]).toMatchObject({ resource: 'lifetime_ids', used: 8, limit: 10 });
    expect(details.resources[0].scope).toStartWith('principal:');
    expect(details.commands).toHaveLength(1);
    const value = Number(details.commands[0].match(/^gbrain config set persistence\.limits\.principal_lifetime_ids (\d+)$/)![1]);
    expect(value).toBeGreaterThanOrEqual(20);
    expect(warning.message).toContain(details.commands[0]);

    await put(ctx, 'notes/cap-8', 'Cap 8.'); await put(ctx, 'notes/cap-9', 'Cap 9.');
    const refusal = await put(ctx, 'notes/cap-10', 'Cap 10.').then(() => null, error => error);
    expect(refusal).toMatchObject({ code: 'queue_capacity', detail: 'principal_lifetime_ids' });
    expect(refusal.message).toContain('10 used of 10');
    expect(refusal.suggestion).toMatch(/gbrain config set persistence\.limits\.principal_lifetime_ids \d+/);
  }, { databaseUrl });
}

const stale = (engine: BrainEngine) => engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS });
const recommended = async (engine: BrainEngine) => computeRecommendations({ stale_pages: await stale(engine), dead_links: 0, missing_embeddings: 0 } as never,
  { staleExtractionBlocked: await staleExtractionBlocked(engine) }).some(step => step.id === 'extract.stale');
const extractStale = (engine: BrainEngine) => extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true });

export async function managedStaleSweep(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('auto_link', 'false');
    await put(ctx, 'companies/acme-example', 'A company.', 'company');
    await put(ctx, 'people/alice-example', 'Works with [[companies/acme-example]].\n\n## Timeline\n\n- **2026-01-02** | test — Met Acme', 'person');
    await disposePersistenceConsumer(engine);
    const [alice] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='people/alice-example'");
    const timeline = () => engine.executeRaw('SELECT date::text,source,summary FROM timeline_entries WHERE page_id=$1 ORDER BY id', [alice.id]);
    const before = await timeline();
    expect(before).toHaveLength(1);
    expect(await stale(engine)).toBe(2);
    expect(await recommended(engine)).toBe(true);

    expect(await extractStale(engine)).toMatchObject({ pagesProcessed: 2, staleRemaining: 0 });
    expect(await timeline()).toEqual(before);
    expect(await engine.executeRaw(`SELECT t.slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
      WHERE f.slug='people/alice-example'`)).toEqual([{ slug: 'companies/acme-example' }]);
    expect(await stale(engine)).toBe(0);
    expect(await recommended(engine)).toBe(false);
    expect(await extractStale(engine)).toMatchObject({ pagesProcessed: 0, staleRemaining: 0 });
  }, { databaseUrl });
}

/** #5984: on Postgres a managed extraction derives several pages at once; every page is stamped and every link resolves either way. */
export async function managedStaleSweepManyPages(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('auto_link', 'false');
    const count = 12;
    for (let i = 0; i < count; i++) await put(ctx, `notes/n${i}`, `Links [[notes/n${(i + 1) % count}]] and [[notes/hub]].`);
    await put(ctx, 'notes/hub', 'The hub.');
    await disposePersistenceConsumer(engine);
    let open = 0, most = 0;
    const transaction = engine.transaction;
    engine.transaction = (async function (this: BrainEngine, fn: Parameters<BrainEngine['transaction']>[0]) {
      if (this !== engine) return transaction.call(this, fn);
      open++; most = Math.max(most, open);
      try { return await transaction.call(this, fn); } finally { open--; }
    }) as BrainEngine['transaction'];
    try {
      const { extractManagedStaleLinks, MANAGED_LINK_EXTRACTION_WIDTH } = await import('../../src/core/persistence/links-maintenance.ts');
      const result = await extractManagedStaleLinks(engine, { sourceId: 'default', mentions: false, slugs: Array.from({ length: count }, (_, i) => `notes/n${i}`) });
      expect(result).toMatchObject({ pages: count + 1, skipped: 0, remaining: 0 });
      expect(most).toBe(engine.kind === 'postgres' ? MANAGED_LINK_EXTRACTION_WIDTH : 1);
    } finally { engine.transaction = transaction; }
    const links = await engine.executeRaw<{ f: string; t: string }>(`SELECT f.slug AS f, t.slug AS t FROM links l JOIN pages f ON f.id=l.from_page_id
      JOIN pages t ON t.id=l.to_page_id ORDER BY 1, 2`);
    expect(links).toEqual(Array.from({ length: 12 }, (_, i) => [{ f: `notes/n${i}`, t: 'notes/hub' }, { f: `notes/n${i}`, t: `notes/n${(i + 1) % 12}` }]).flat()
      .sort((a, b) => a.f < b.f ? -1 : a.f > b.f ? 1 : a.t < b.t ? -1 : 1));
    expect(await stale(engine)).toBe(0);
  }, { databaseUrl });
}

/** A stored row that differs from its bullet only by whitespace is the same entry to the coordinator; stale extraction must not add a twin. */
export async function managedStaleSweepKeepsNormalizedTimeline(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('auto_link', 'false');
    await put(ctx, 'people/alice-example', 'A person.\n\n## Timeline\n\n- **2026-01-02** | test — Met Acme', 'person');
    await disposePersistenceConsumer(engine);
    const [alice] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='people/alice-example'");
    // A row written before timeline normalization (whitespace differs from the bullet).
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
      tx.executeRaw("UPDATE timeline_entries SET summary='Met  Acme ' WHERE page_id=$1", [alice.id]), TEST_WRITE_ATTRIBUTION));
    const timeline = () => engine.executeRaw('SELECT date::text,source,summary FROM timeline_entries WHERE page_id=$1 ORDER BY id', [alice.id]);
    const before = await timeline();
    expect(before).toEqual([{ date: '2026-01-02', source: 'test', summary: 'Met  Acme ' }]);
    expect(await extractStale(engine)).toMatchObject({ pagesProcessed: 1, staleRemaining: 0 });
    expect(await timeline()).toEqual(before);
  }, { databaseUrl });
}

export async function staleExtractionWithheldWhenItCannotRun(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('auto_link', 'false');
    await put(ctx, 'notes/example', 'Stale page.');
    await disposePersistenceConsumer(engine);
    expect(await recommended(engine)).toBe(true);
    await engine.setConfig('schema_pack.source.default', 'missing-pack-example');
    expect(await staleExtractionBlocked(engine)).toContain('active schema pack is unavailable for source default');
    expect(await recommended(engine)).toBe(false);
    await engine.setConfig('schema_pack', 'missing-pack-example');
    await engine.setConfig('schema_pack.source.default', 'gbrain-base');
    expect(await staleExtractionBlocked(engine)).toBeUndefined();
    expect(await recommended(engine)).toBe(true);
  }, { databaseUrl });
}
