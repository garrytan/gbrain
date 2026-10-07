/**
 * #5988 Lane B item 5: Git holds outside sync itself. `sources status <id>`
 * filters to the source and lists its held files (X2 fields, text and JSON);
 * `sources retry-held` schedules a re-screen of a Git source's held files;
 * `sync --retry-held` refuses with the pointer; Git holds never block writer
 * deactivation or activation (X14); a put_page refused over a held file names
 * the hold instead of reconciliation (E26).
 *
 * #6188 PR4 (D6, D16, D17, E35, Codex CEO #7): for a fence-only, a
 * frontmatter-only and a mixed source, every DB-backed surface (sources
 * status JSON and text, retry-held, doctor git_held_files and its banner
 * line, the sync hold report, get_page file_held, the held_files notice, the
 * held-file write refusal) names the right repair command and a fence-only
 * source never mentions frontmatter; a fence hold's rendered next follows its
 * state on the CLI and HTTP transports with the maintenance run active and
 * inactive; a remote status read returns the owner handoff; no claim, holder
 * or kind text reaches any of them.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { runSources } from '../src/commands/sources.ts';
import { retryHeld, runRetryHeld } from '../src/commands/sources-retry-held.ts';
import { parseSyncFlags } from '../src/commands/sync/args.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { heldFileMessage, writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { readGitHold, readGitHoldListing, readGitHoldRetryPaths, writeGitHold, type GitHoldRecord } from '../src/core/persistence/sync-holds.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { carryLegacyFailCounts } from '../src/core/connectors/item-holds.ts';
import { connectorCheckpointKey, connectorIdentity } from '../src/core/persistence/connector-identity.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { waitFor } from './helpers/wait-for.ts';
import { put } from './helpers/wave-fixture.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { buildHoldReport, readSyncHoldPolicy } from '../src/core/persistence/sync-holds.ts';
import { heldFilesNotice, readHeldCoverage } from '../src/core/persistence/held-reads.ts';
import { heldFileDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { gitHeldFilesCheck } from '../src/commands/doctor/checks/git-holds.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { bannerFindingLine } from '../src/commands/doctor/upgrade-banner.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { cliRenderContext, renderAction, type Action } from '../src/core/agent-output.ts';
import { fenceMessage } from '../src/core/fence-repair/reasons.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';

type HoldInput = Omit<GitHoldRecord, 'version' | 'held_at' | 'updated_at'>;

const incarnationOf = async (engine: BrainEngine, sourceId: string) =>
  (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]))[0].incarnation;

const hold = (sourceId: string, incarnation: string, path: string, extra: Partial<HoldInput> = {}): HoldInput => ({
  source_id: sourceId, incarnation, path, source_path: path, slug: path.replace(/\.md$/, ''), page_id: null, code: 'invalid_frontmatter',
  message: 'Invalid YAML frontmatter: key "title" at line 2 continues on unquoted lines.', upstream_version: `sha-${path}`,
  observed_at: '2026-10-01T00:00:00.000Z', run_id: 'run-1', mode: 'managed',
  meta: { reason: 'needs_interpretation', key: 'title', line: 2, recovery_version: 1 }, ...extra,
});

async function captured(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try { await run(); } finally { log.mockRestore(); warn.mockRestore(); }
  return lines.join('\n');
}

describe('sources status and retry-held on Git sources', () => {
  let engine: PGLiteEngine;
  let home: string;

  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    home = mkdtempSync(join(tmpdir(), 'gbrain-hold-surfaces-'));
    for (const id of ['notes-git', 'other-git']) {
      mkdirSync(join(home, id));
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, join(home, id)]);
    }
    await engine.putPage('notes/stale', { type: 'note', title: 'Stale', compiled_truth: 'Old body.' }, { sourceId: 'notes-git' });
    const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='notes-git' AND slug='notes/stale'");
    const notes = await incarnationOf(engine, 'notes-git');
    await writeGitHold(engine, hold('notes-git', notes, 'notes/stale.md', { page_id: Number(page.id) }));
    await writeGitHold(engine, hold('notes-git', notes, 'notes/huge.md', { code: 'file_too_large', message: 'File too large (12 MB).', upstream_version: null,
      meta: { recovery_version: 1 } }));
    await writeGitHold(engine, hold('other-git', await incarnationOf(engine, 'other-git'), 'other/a.md'));
  }, 120_000);

  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);

  test('sources status <id> --json lists only that source, with its held files and their X2 fields', async () => {
    const doc = JSON.parse(await captured(() => runSources(engine, ['status', 'notes-git', '--json'])));
    expect(doc.sources.map((s: { source_id: string }) => s.source_id)).toEqual(['notes-git']);
    const holds = doc.sources[0].git_holds;
    expect(holds).toMatchObject({ count: 2, sync_argv: ['gbrain', 'sync', '--source', 'notes-git'] });
    expect(holds.truncated).toBeUndefined();
    const byPath = Object.fromEntries(holds.items.map((item: { path: string }) => [item.path, item]));
    expect(byPath['notes/stale.md']).toMatchObject({ code: 'invalid_frontmatter', reason: 'needs_interpretation', key: 'title', line: 2, stale: true,
      docs: 'docs/guides/write-refusals.md#invalid_frontmatter-needs_interpretation',
      fix: { argv: ['gbrain', 'repair', 'frontmatter', '--source', 'notes-git', '--include-ambiguous'] } });
    expect(typeof byPath['notes/stale.md'].held_since).toBe('string');
    expect(byPath['notes/huge.md']).toMatchObject({ code: 'file_too_large', stale: false, docs: 'docs/guides/write-refusals.md#file_too_large' });
    expect(byPath['notes/huge.md'].fix.why).toContain('size limit is fixed');

    const all = JSON.parse(await captured(() => runSources(engine, ['status', '--json'])));
    expect(all.sources.find((s: { source_id: string }) => s.source_id === 'other-git').git_holds.count).toBe(1);
    expect(all.sources.find((s: { source_id: string }) => s.source_id === 'default').git_holds).toBeUndefined();
  });

  test('sources status <id> text names each held file, its next step and the re-screen commands; other sources are not listed', async () => {
    const text = await captured(() => runSources(engine, ['status', 'notes-git']));
    expect(text).toContain('notes-git: 2 held file(s): not imported, and they do not block sync.');
    expect(text).toContain('read-only for put_page until the file is repaired');
    expect(text).toMatch(/Held notes\/stale\.md: invalid_frontmatter \(needs_interpretation\) at line 2, key "title"; .* Next: gbrain repair frontmatter --source notes-git --include-ambiguous/);
    expect(text).toMatch(/Held notes\/huge\.md: file_too_large; its page is missing until the file imports\. Next: gbrain config get sync\.exclude/);
    expect(text).toContain('Most holds re-screen on the next sync by themselves');
    expect(text).toContain('gbrain sync --source notes-git');
    expect(text).toContain('gbrain sources retry-held notes-git');
    expect(text).not.toContain('other-git');
  });

  test('sources status lists at most sync.hold_cap holds per source, limited in SQL, with the outstanding count from the summary row', async () => {
    const listing = await readGitHoldListing(engine, ['notes-git', 'other-git', 'default'], 1);
    expect(listing.map(source => [source.sourceId, source.count, source.holds.map(record => record.path)])).toEqual([
      ['notes-git', 2, ['notes/huge.md']], ['other-git', 1, ['other/a.md']]]);
    await engine.setConfig('sync.hold_cap', '1');
    try {
      const doc = JSON.parse(await captured(() => runSources(engine, ['status', 'notes-git', '--json'])));
      expect(doc.sources[0].git_holds).toMatchObject({ count: 2, truncated: true });
      expect(doc.sources[0].git_holds.items.map((item: { path: string }) => item.path)).toEqual(['notes/huge.md']);
      const text = await captured(() => runSources(engine, ['status', 'notes-git']));
      expect(text).toContain('notes-git: 2 held file(s)');
    } finally { await engine.unsetConfig('sync.hold_cap'); }
  });

  test('sources status <unknown id> refuses with not_found and the list command', async () => {
    await expect(runSources(engine, ['status', 'missing-src'])).rejects.toMatchObject({ code: 'not_found',
      fix: { argv: ['gbrain', 'sources', 'list', '--json'] } });
  });

  test('retry-held on a Git source: --dry-run changes nothing; the real run records a re-screen of every held path', async () => {
    const dry = await retryHeld(engine, 'notes-git', { dryRun: true });
    expect(dry).toMatchObject({ kind: 'git', dry_run: true, scheduled: 0, fix: { argv: ['gbrain', 'sources', 'retry-held', 'notes-git'] } });
    expect(dry.items.map(item => [item.key, item.action])).toEqual([['notes/huge.md', 'would_retry'], ['notes/stale.md', 'would_retry']]);
    expect(await readGitHoldRetryPaths(engine, 'notes-git', await incarnationOf(engine, 'notes-git'))).toEqual([]);

    const text = await captured(() => runRetryHeld(engine, ['notes-git']));
    expect(text).toContain('notes/stale.md (invalid_frontmatter, needs_interpretation): retry_scheduled');
    expect(text).toContain('2 held file(s) scheduled for a re-screen; none has run yet.');
    expect(text).toContain('Most holds re-screen on the next sync by themselves');
    expect(text).toContain('Run it now with: gbrain sync --source notes-git,');
    expect(text).toContain('gbrain repair frontmatter --source notes-git');
    expect((await readGitHoldRetryPaths(engine, 'notes-git', await incarnationOf(engine, 'notes-git'))).sort()).toEqual(['notes/huge.md', 'notes/stale.md']);

    const json = JSON.parse(await captured(() => runRetryHeld(engine, ['notes-git', '--json'])));
    expect(json).toMatchObject({ source_id: 'notes-git', kind: 'git', scheduled: 2, fix: { argv: ['gbrain', 'sync', '--source', 'notes-git'] } });
    expect((await retryHeld(engine, 'notes-git', { dryRun: true })).items.every(item => item.action === 'retry_scheduled')).toBe(true);
    expect((await retryHeld(engine, 'default')).next_action).toBe('No held files for default.');
  });
});

describe('gbrain sync --retry-held', () => {
  test('is refused with a typed error pointing at sources retry-held', () => {
    expect(CLI_FLAG_REGISTRY.sync).toContain('--retry-held');
    let error: any;
    try { parseSyncFlags(['--retry-held', '--source', 'notes-git']); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'invalid_params', fix: { argv: ['gbrain', 'sources', 'retry-held', 'notes-git'],
      verify: { argv: ['gbrain', 'sources', 'status', 'notes-git', '--json'] } } });
    expect(error.message).toContain('no --retry-held flag');
    expect(error.suggestion).toContain('gbrain sources retry-held notes-git');
    try { parseSyncFlags(['--retry-held']); } catch (e) { error = e; }
    expect(error.fix.argv).toEqual(['gbrain', 'sources', 'retry-held', '<source-id>']);
    expect(error.fix.inputs).toEqual([expect.objectContaining({ name: 'source-id' })]);
  });
});

describe('a page whose file is held refuses put_page naming the hold', () => {
  let engine: PGLiteEngine;
  let home: string;
  let root: string;
  let worktreeId: string;
  const sourceId = 'held-drift';

  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    home = mkdtempSync(join(tmpdir(), 'gbrain-held-drift-'));
    root = join(home, 'source'); mkdirSync(root);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    worktreeId = (await claimWorktree(engine, sourceId, root)).worktree_id;
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);

  async function seed(slug: string) {
    await engine.putPage(slug, { type: 'note', title: 'Held', compiled_truth: 'Last good body' }, { sourceId });
    await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', [`${slug}.md`, sourceId, slug]);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const file = join(root, `${slug}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
    return { snapshot, file, row: { source_id: sourceId, worktree_id: worktreeId, slug } };
  }

  test('drift over a held file names the hold, keeps file_database_drift, and points at repair instead of reconcile', async () => {
    const { snapshot, file, row } = await seed('notes/held');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^title:.*$/m, 'title: Broken\n  continued tweet text'));
    await expect(prepareFileTarget(engine, row, snapshot, 'Replacement')).rejects.toMatchObject({ detail: 'file_database_drift',
      suggestion: expect.stringContaining('gbrain sources reconcile') });
    await writeGitHold(engine, hold(sourceId, await incarnationOf(engine, sourceId), 'notes/held.md', { page_id: Number(snapshot.page.id) }));
    let error: any;
    try { await prepareFileTarget(engine, row, snapshot, 'Replacement'); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'source_changed', detail: 'file_database_drift', message: heldFileMessage('drift', 'invalid_frontmatter'),
      fix: { argv: ['gbrain', 'repair', 'frontmatter', '--source', sourceId, '--include-ambiguous'] } });
    expect(error.suggestion).toContain('Sync holds notes/held.md in source held-drift (invalid_frontmatter, needs_interpretation at line 2, key "title")');
    expect(error.suggestion).toContain('read-only for put_page until the file is repaired');
    expect(error.suggestion).not.toContain('sources reconcile');
    expect(error.message).not.toContain('continued tweet text');
  });

  test('a remote caller hitting a held file gets the code and the host operator command, never the path or key', async () => {
    const { snapshot, file, row } = await seed('notes/held-remote');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^title:.*$/m, 'title: Broken\n  continued tweet text'));
    await writeGitHold(engine, hold(sourceId, await incarnationOf(engine, sourceId), 'notes/held-remote.md', { page_id: Number(snapshot.page.id) }));
    let error: any;
    try { await prepareFileTarget(engine, row, snapshot, 'Replacement', undefined, { remote: true }); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'source_changed', detail: 'file_database_drift', message: heldFileMessage('drift', 'invalid_frontmatter'),
      fix: { actor: 'host_admin', argv: ['gbrain', 'repair', 'frontmatter', '--source', sourceId] } });
    const text = JSON.stringify({ message: error.message, suggestion: error.suggestion, fix: error.fix });
    expect(text).toContain('read-only for put_page until the brain host operator repairs the file');
    for (const hidden of ['held-remote.md', '"title"', root, 'continued tweet text']) expect(text).not.toContain(hidden);
  });

  test('an unindexed held file occupying a new page path names the hold', async () => {
    const file = join(root, 'notes', 'new-held.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '---\ntitle: Broken\n  continued\n---\nBody\n');
    const row = { source_id: sourceId, worktree_id: worktreeId, slug: 'notes/new-held' };
    await expect(prepareFileTarget(engine, row, null, 'Rendered')).rejects.toMatchObject({ message: 'An unindexed file already occupies the canonical page path.' });
    await writeGitHold(engine, hold(sourceId, await incarnationOf(engine, sourceId), 'notes/new-held.md'));
    await expect(prepareFileTarget(engine, row, null, 'Rendered')).rejects.toMatchObject({ code: 'source_changed',
      message: heldFileMessage('occupied', 'invalid_frontmatter'), suggestion: expect.stringContaining('does not exist yet') });
  });

  test('receipts keep only the location-free message; the diagnostic maps it to the same reasons with the repair command', () => {
    expect(writeFailureDiagnostic('source_changed', heldFileMessage('drift', 'invalid_frontmatter'))).toMatchObject({ reason: 'file_database_drift',
      message: heldFileMessage('drift', 'invalid_frontmatter'), suggestion: expect.stringContaining('gbrain repair frontmatter --source <source>') });
    const occupied = writeFailureDiagnostic('source_changed', heldFileMessage('occupied', 'file_too_large'));
    expect(occupied.reason).toBe('canonical_path_occupied');
    expect(occupied.suggestion).toContain('refuses put_page until the file is repaired');
    expect(writeFailureDiagnostic('source_changed', 'The canonical file contains an uncoordinated local edit.').suggestion).toContain('gbrain sources reconcile');
  });
});

describe('Git holds and writer mode changes (X14)', () => {
  const gmailConfig = { kind: 'google', g_account: 'reader@example.com', g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
  const admin = (engine: BrainEngine, operation: string, params: Record<string, unknown> = {}) =>
    runPersistenceAdministration(engine, operation as never, params) as Promise<Record<string, any>>;

  test('holds survive activation, never block deactivation, and survive it unchanged; uncarriable connector holds still block', () => managedBrain(async ({ engine, ctx, root }) => {
    const incarnation = await incarnationOf(engine, 'default');
    const before = await readGitHold(engine, 'default', incarnation, 'notes/held.md');
    expect(before).toMatchObject({ path: 'notes/held.md', code: 'invalid_frontmatter' });

    // A managed brain re-screens with --no-pull.
    expect((await retryHeld(engine, 'default', { dryRun: true })).fix?.argv).toEqual(['gbrain', 'sources', 'retry-held', 'default']);
    expect((await retryHeld(engine, 'default')).fix?.argv).toEqual(['gbrain', 'sync', '--source', 'default', '--no-pull']);

    // A held page refuses put_page through the coordinated write path with the hold named.
    await put(ctx, 'notes/held', 'Last good body.');
    writeFileSync(join(root, 'notes', 'held.md'), '---\ntitle: Broken\n  continued tweet text\n---\n\nNewer body.\n');
    const current = (await engine.readPageSnapshot('notes/held', { sourceId: 'default' }))!;
    const refused = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/held', request_id: randomUUID(), expected_revision: current.revision,
      content: '---\ntype: note\ntitle: notes/held\n---\n\nAgent edit.\n' } }).then(() => null, (e: unknown) => e as Record<string, any>);
    expect(refused).not.toBeNull();
    const suggestion = String(refused!.suggestion);
    expect(suggestion).toContain('gbrain repair frontmatter --source default');
    expect(suggestion).toContain('retrying this write refuses the same way');
    expect(refused).toMatchObject({ code: 'source_changed', detail: 'file_database_drift', message: heldFileMessage('drift', 'invalid_frontmatter') });
    expect(JSON.stringify(refused)).not.toContain('sources reconcile');

    const gmailIncarnation = await incarnationOf(engine, 'gmail-x');
    const key = connectorCheckpointKey('gmail-x', gmailIncarnation, connectorIdentity('google', gmailConfig, null));
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-connector',$1,$2::text::jsonb)`,
      [key, JSON.stringify([{ state: { history_id: 'h1', item_holds: carryLegacyFailCounts(undefined, { 'thread-1': 3 }, id => id, '2026-10-01T00:00:00.000Z') } }])]);

    // The put_page above returns at publication; its Git effect finishes in the background before the writer is quiet.
    await waitFor(async () => (await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE state IN ('queued','running') LIMIT 1")).length === 0,
      { timeoutMs: 15_000, label: 'put_page effects settled' });
    const dry = await admin(engine, 'writer_deactivate', { dry_run: true });
    expect(dry.blockers.map((b: { kind: string; source_id?: string }) => `${b.kind}:${b.source_id ?? ''}`)).toEqual(['connector_holds:gmail-x']);
    await expect(admin(engine, 'writer_deactivate', { admin_intent: 'writer_deactivate', expected_state: await writerAdminState(engine) }))
      .rejects.toMatchObject({ code: 'writer_not_quiesced' });

    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [key]);
    const done = await admin(engine, 'writer_deactivate', { admin_intent: 'writer_deactivate', expected_state: await writerAdminState(engine) });
    expect(done).toMatchObject({ mode: 'classic', deactivated: true, blockers: [] });
    expect(await readGitHold(engine, 'default', incarnation, 'notes/held.md')).toEqual(before);
    expect((await readGitHoldRetryPaths(engine, 'default', incarnation))).toEqual(['notes/held.md']);
    // Classic mode re-screens with plain sync.
    expect((await retryHeld(engine, 'default')).fix?.argv).toEqual(['gbrain', 'sync', '--source', 'default']);
  }, { setup: async ({ engine }) => {
    await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::text::jsonb)', ['gmail-x', JSON.stringify(gmailConfig)]);
    await writeGitHold(engine, hold('default', await incarnationOf(engine, 'default'), 'notes/held.md', { run_id: randomUUID() }));
  } }), 180_000);
});

describe('#6188 fence holds on every DB-backed surface: the router and the fix by state', () => {
  let engine: PGLiteEngine;
  let home: string;
  const SECRETS = ['Sentinelclaimq92 renews yearly', 'Sentinelholderq92 Example', 'sentinelkindq92'];
  const http = { transport: 'http' as const, isCallable: () => false, preapproved: () => false, routing: {} } as never;
  const cli = cliRenderContext();
  const getPage = operations.find(op => op.name === 'get_page')!;
  const fenceAt = { reason: 'holder_unresolved' as const, fence: 'takes' as const, section: 'body' as const, rows: [3], columns: ['who'], line: 7 };
  const fenceHold = (sourceId: string, incarnation: string, path: string, pageId: number | null, extra: Partial<HoldInput['meta']> = {}): HoldInput => hold(sourceId, incarnation, path, {
    code: 'invalid_fence', page_id: pageId, message: fenceMessage(fenceAt),
    meta: { reason: 'holder_unresolved', line: 12, recovery_version: RECOVERY_VERSION, fence: fenceAt, fence_version: 1, ...extra } });
  const ctx = (sourceId: string, remote: boolean) => ({ engine, config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} },
    dryRun: false, remote, sourceId, emitNotice() {}, emitResponseMeta() {} }) as unknown as OperationContext;
  const pageId = async (sourceId: string, slug: string) => {
    await engine.putPage(slug, { type: 'note', title: 'Held page', compiled_truth: 'Last good body.' }, { sourceId });
    return Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.id);
  };

  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    home = mkdtempSync(join(tmpdir(), 'gbrain-fence-surfaces-'));
    for (const id of ['fences-only', 'frontmatter-only', 'mixed-holds']) {
      mkdirSync(join(home, id));
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, join(home, id)]);
    }
    const fenceInc = await incarnationOf(engine, 'fences-only');
    await writeGitHold(engine, fenceHold('fences-only', fenceInc, 'people/held-a.md', await pageId('fences-only', 'people/held-a')));
    await writeGitHold(engine, fenceHold('fences-only', fenceInc, 'people/held-b.md', null, {
      reason: 'takes_kind_unsupported', fence: { reason: 'takes_kind_unsupported', fence: 'takes', section: 'body', rows: [2], columns: ['kind'], line: 6 } }));
    await writeGitHold(engine, hold('frontmatter-only', await incarnationOf(engine, 'frontmatter-only'), 'notes/broken.md'));
    const mixedInc = await incarnationOf(engine, 'mixed-holds');
    await writeGitHold(engine, hold('mixed-holds', mixedInc, 'notes/broken.md'));
    await writeGitHold(engine, fenceHold('mixed-holds', mixedInc, 'people/held-c.md', null));
  }, 120_000);

  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);

  const expectRoute = (text: string, kind: 'fences' | 'frontmatter' | 'mixed', sourceId: string) => {
    if (kind !== 'frontmatter') expect(text).toContain(`gbrain repair fences --source ${sourceId}`);
    if (kind !== 'fences') expect(text).toContain(`gbrain repair frontmatter --source ${sourceId}`);
    if (kind === 'fences') expect(text).not.toContain('repair frontmatter');
    if (kind === 'frontmatter') expect(text).not.toContain('repair fences');
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  };
  const SOURCES = [['fences-only', 'fences'], ['frontmatter-only', 'frontmatter'], ['mixed-holds', 'mixed']] as const;

  test('every surface names the right repair command for fence-only, frontmatter-only and mixed sources (D6)', async () => {
    for (const [sourceId, kind] of SOURCES) {
      const status = JSON.parse(await captured(() => runSources(engine, ['status', sourceId, '--json']))).sources[0].git_holds;
      for (const item of status.items) {
        if (item.code === 'invalid_fence') expect(item.fix.argv).toEqual(['gbrain', 'repair', 'fences', '--source', sourceId, '--only', item.path]);
        else expect(item.fix.argv.slice(0, 3)).toEqual(['gbrain', 'repair', 'frontmatter']);
      }
      const text = await captured(() => runSources(engine, ['status', sourceId]));
      if (kind !== 'frontmatter') expect(text).toContain(`gbrain repair fences --source ${sourceId} --only`);
      if (kind === 'fences') expect(text).not.toContain('repair frontmatter');
      expectRoute((await retryHeld(engine, sourceId, { dryRun: false })).next_action, kind, sourceId);
      const doctor = await gitHeldFilesCheck(engine, [sourceId]);
      expectRoute(doctor.message, kind, sourceId);
      expect(doctor.fix!.argv).toEqual(kind === 'fences' ? ['gbrain', 'repair', 'fences', '--source', sourceId] : ['gbrain', 'repair', 'frontmatter', '--source', sourceId]);
      const banner = bannerFindingLine({ spec: WAVE_CHECKS.find(spec => spec.id === 'git_held_files')!, check: doctor, state: 'finding' });
      expectRoute(banner, kind, sourceId);
      const report = await buildHoldReport(engine, { sourceId, incarnation: await incarnationOf(engine, sourceId), runId: 'none', remote: false,
        policy: await readSyncHoldPolicy(engine), screened: 0 });
      expectRoute(`${report.holds_fix!.argv!.join(' ')} ${report.holds_fix!.why}`, kind, sourceId);
      const remote = await buildHoldReport(engine, { sourceId, incarnation: await incarnationOf(engine, sourceId), runId: 'none', remote: true,
        policy: await readSyncHoldPolicy(engine), screened: 0 });
      expect(remote.holds_fix!.actor).toBe('host_admin');
      expectRoute(remote.holds_fix!.user_message!, kind, sourceId);
      const coverage = await readHeldCoverage(engine, { sourceId });
      const notice = heldFilesNotice(coverage, false)!.fix!;
      expectRoute(`${notice.argv!.join(' ')} ${notice.why}`, kind, sourceId);
      expectRoute(heldFilesNotice(coverage, true)!.fix!.user_message!, kind, sourceId);
    }
    expect(heldFileDiagnostic(heldFileMessage('drift', 'invalid_fence'), 'fences-only')!.suggestion).toContain('gbrain repair fences --source fences-only');
  });

  test('a fence hold\'s rendered next follows its state on CLI and HTTP, with the maintenance run inactive and active (D17, E35)', async () => {
    const items = async () => {
      const status = JSON.parse(await captured(() => runSources(engine, ['status', 'fences-only', '--json']))).sources[0].git_holds.items as Array<{ path: string; fix: Action; fence: Record<string, unknown> }>;
      return Object.fromEntries(status.map(item => [item.path, item]));
    };
    const inactive = await items();
    // Inactive: the auto-retry hold is the preview, then the apply; the manual one is the preview, then the sync. Never "no action needed".
    expect(renderAction(inactive['people/held-a.md']!.fix, cli)).toMatchObject({ next: 'run', then: { argv: ['gbrain', 'repair', 'fences', '--source', 'fences-only', '--only', 'people/held-a.md', '--apply'] } });
    expect(inactive['people/held-a.md']!.fix.why).not.toContain('No action is needed');
    expect(inactive['people/held-a.md']!.fence).toMatchObject({ tier: 'resolver', auto_retry: false, classes: ['holder_unresolved'] });
    expect(renderAction(inactive['people/held-b.md']!.fix, cli)).toMatchObject({ next: 'run', then: { argv: ['gbrain', 'sync', '--source', 'fences-only', '--no-pull'] } });
    for (const item of Object.values(inactive)) expect(renderAction(item.fix, http).next).toBe('tell_user_to_run');

    // A completed brain-wide maintenance job is the evidence that the maintenance run is active.
    await engine.executeRaw(`INSERT INTO minion_jobs (submission_authority, name, status, data, queue, priority, created_at, finished_at)
      VALUES ('{"version":1,"kind":"application"}'::jsonb, 'autopilot-global-maintenance', 'completed', '{}'::jsonb, 'default', 0, now(), now())`);
    try {
      const active = await items();
      expect(active['people/held-a.md']!.fix.why).toContain('No action is needed: the next maintenance run repairs it automatically');
      expect(active['people/held-a.md']!.fix.then).toBeUndefined();
      expect(active['people/held-a.md']!.fence).toMatchObject({ auto_retry: true });
      expect(renderAction(active['people/held-a.md']!.fix, cli).next).toBe('run');
      expect(active['people/held-b.md']!.fix.why).toContain('gbrain will not guess this repair');
      // Model repair off: a Tier 3 hold waits on a paid setting, which the CLI renders as ask_user.
      await engine.setConfig('fences.repair.llm', 'false');
      await writeGitHold(engine, fenceHold('fences-only', await incarnationOf(engine, 'fences-only'), 'people/held-d.md', null, {
        reason: 'short_row', fence: { reason: 'short_row', fence: 'facts', section: 'body', rows: [4], columns: [], line: 9 } }));
      const paid = (await items())['people/held-d.md']!;
      expect(renderAction(paid.fix, cli)).toMatchObject({ next: 'ask_user', consent: ['paid'], argv: ['gbrain', 'config', 'set', 'fences.repair.llm', 'true'] });
      expect(renderAction(paid.fix, http).next).toBe('tell_user_to_run');
      const text = await captured(() => runSources(engine, ['status', 'fences-only']));
      expect(text).toContain('No action needed: the next maintenance run repairs it.');
      expect(text).toContain('Ask the user first, then: gbrain config set fences.repair.llm true');
    } finally {
      await engine.executeRaw("DELETE FROM minion_jobs WHERE name='autopilot-global-maintenance'");
      await engine.unsetConfig('fences.repair.llm');
      await clearHold('fences-only', 'people/held-d.md');
    }
  });

  test('a remote status read of a held fence returns the owner handoff, saying whether it clears by itself, with no path (Codex CEO #7)', async () => {
    const local = await getPage.handler(ctx('fences-only', false), { slug: 'people/held-a' }) as Record<string, any>;
    expect(local.file_held).toMatchObject({ code: 'invalid_fence', path: 'people/held-a.md', line: 12,
      fence: { fence: 'takes', section: 'body', rows: [3], columns: ['who'], classes: ['holder_unresolved'] },
      fix: { argv: ['gbrain', 'repair', 'fences', '--source', 'fences-only', '--only', 'people/held-a.md'] } });
    const remote = await getPage.handler(ctx('fences-only', true), { slug: 'people/held-a' }) as Record<string, any>;
    expect(remote.file_held.path).toBeUndefined();
    expect(remote.file_held.fence.rows).toEqual([]);
    expect(remote.file_held.fix).toMatchObject({ actor: 'host_admin', argv: ['gbrain', 'repair', 'fences', '--source', 'fences-only'] });
    expect(renderAction(remote.file_held.fix, http).next).toBe('tell_user_to_run');
    expect(remote.file_held.fix.user_message).toContain('It does not clear by itself because no maintenance run is active on the brain host');
    await engine.setConfig('autopilot.last_global_at', new Date().toISOString());
    try {
      const active = await getPage.handler(ctx('fences-only', true), { slug: 'people/held-a' }) as Record<string, any>;
      expect(active.file_held.fix.user_message).toContain('It clears by itself');
      expect(active.file_held.fence.auto_retry).toBe(true);
    } finally { await engine.unsetConfig('autopilot.last_global_at'); }
    const text = JSON.stringify(remote.file_held);
    for (const hidden of ['people/held-a.md', home, ...SECRETS]) expect(text).not.toContain(hidden);
  });

  async function clearHold(sourceId: string, path: string) {
    const { clearGitHold } = await import('../src/core/persistence/sync-holds.ts');
    await clearGitHold(engine, { sourceId, incarnation: await incarnationOf(engine, sourceId), path, observedAt: '2999-01-01T00:00:00.000Z' });
  }
});
