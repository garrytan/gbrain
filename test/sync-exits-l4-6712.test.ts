/**
 * #6712 PR 2 (L4): the exits of a held or refused page.
 *
 * Protects: the two content-refusal hold codes in the fault table (they read as "Unknown code" systemic faults before),
 * `source_changed` routed by its recorded reason (two-sided drift to the scoped file-drift preview, a missing file to the
 * ghost repair, an admission race to a retry, a binding or unsafe target to an inspection), hold escalation that needs
 * failed attempts AND a day since the path was first held (never a live editor, never an image), the one `--since`
 * parser and the concrete instant every printed file-drift command carries, the post-sync ghost count that names
 * `repair ghost-pages` and never deletes, and the soak counters (interventions apart from content decisions) that
 * doctor reports. PGLite always; Postgres too when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { classifySyncFault, HOLD_ATTEMPTS_NEEDS_HUMAN, HOLD_ESCALATE_MS } from '../src/core/persistence/sync-fault-class.ts';
import { classifyTerminal } from '../src/core/persistence/terminal-classify.ts';
import { holdEscalation, readGitHold, recordHoldAttempt, writeGitHold, type GitHoldRecord } from '../src/core/persistence/sync-holds.ts';
import { nonPlainSyncFlags, readSoakCounters, recordSoakEvent, sweepNeedsHumanHolds } from '../src/core/persistence/soak-counters.ts';
import { countSyncGhosts } from '../src/core/persistence/sync-ghosts.ts';
import { parseSince } from '../src/core/since.ts';
import { parseRepairArgs } from '../src/commands/repair.ts';
import { fileDriftRepair } from '../src/core/repair/file-drift.ts';
import { soakCountersEntry } from '../src/commands/doctor/checks/ops-sections.ts';
import { performSync } from '../src/commands/sync.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';

describe('#6712 PR 2 L4: the fault table and source_changed routing', () => {
  test('purged_content and write_gate_rejected are page holds a person settles, not unknown systemic codes', () => {
    for (const code of ['purged_content', 'write_gate_rejected']) {
      const verdict = classifySyncFault({ code });
      expect(verdict).toMatchObject({ class: 'page', safe_actions: ['none'], needs_human: true });
      expect(verdict.human_reason).not.toContain('Unknown code');
    }
    expect(classifySyncFault({ code: 'purged_content' }).human_reason).toContain('gbrain pages unpurge');
    expect(classifySyncFault({ code: 'write_gate_rejected' }).human_reason).toContain('write_gate.external_mode');
  });

  test('source_changed routes by its recorded reason', () => {
    expect(classifySyncFault({ code: 'source_changed', detail: 'file_database_drift' })).toMatchObject({ class: 'page', safe_actions: ['reconcile'], needs_human: true,
      human_reason: expect.stringContaining('gbrain repair file-drift') });
    expect(classifySyncFault({ code: 'source_changed', detail: 'canonical_file_missing' })).toMatchObject({ class: 'page', safe_actions: ['repair'], needs_human: true,
      human_reason: expect.stringContaining('gbrain repair ghost-pages') });
    for (const detail of ['pending_import', 'raw_file_changed', 'pinned_git_worktree_conflict']) {
      expect(classifySyncFault({ code: 'source_changed', detail })).toMatchObject({ class: 'page', safe_actions: ['retry'], needs_human: false });
    }
    for (const detail of ['source_binding_changed', 'unsafe_file_target']) {
      expect(classifySyncFault({ code: 'source_changed', detail })).toMatchObject({ class: 'systemic', safe_actions: ['none'], needs_human: true,
        human_reason: expect.stringContaining('gbrain sources writer status') });
    }
    const base = { source_id: 'src', slug: 'notes/a', operation: 'put_page', state: 'conflict', error_code: 'source_changed', recovery: null, blocked_reason: null, compacted: true };
    const drift = classifyTerminal({ ...base, error_detail: { reason: 'file_database_drift' } })!;
    expect(drift).toMatchObject({ category: 'file_conflict', code: 'source_changed', safe_actions: ['reconcile'], needs_human: true });
    expect(drift.action.argv).toEqual(['gbrain', 'repair', 'file-drift', '--source', 'src', '--slug', 'notes/a', '--prefer', 'database']);
    const ghost = classifyTerminal({ ...base, error_detail: { reason: 'canonical_file_missing' } })!;
    expect(ghost.action.argv).toEqual(['gbrain', 'repair', 'ghost-pages', '--source', 'src']);
    const binding = classifyTerminal({ ...base, error_detail: { reason: 'source_binding_changed' } })!;
    expect(binding).toMatchObject({ category: 'diagnosis_required', needs_human: true, human_reason: expect.stringContaining('replaced, archived or re-bound') });
    expect(binding.action.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'src', '--json']);
    expect(classifyTerminal({ ...base, error_detail: { reason: 'pending_import' } })).toMatchObject({ category: 'sync_fault', safe_actions: ['retry'], needs_human: false });
  });
});

describe('#6712 PR 2 L4: --since', () => {
  test('one parser: an age becomes one concrete instant, ISO is normalized, anything else refuses', () => {
    const now = Date.parse('2026-10-15T12:00:00.000Z');
    expect(parseSince('7d', '--since', now)).toBe('2026-10-08T12:00:00.000Z');
    expect(parseSince('90s', '--since', now)).toBe('2026-10-15T11:58:30.000Z');
    expect(parseSince('2026-10-01', '--since', now)).toBe('2026-10-01T00:00:00.000Z');
    expect(parseSince('2026-10-01T08:30:00+02:00', '--since', now)).toBe('2026-10-01T06:30:00.000Z');
    expect(parseSince(undefined)).toBeUndefined();
    for (const bad of ['yesterday', '7w', '5', '2026-13-45']) expect(() => parseSince(bad)).toThrow(/could not parse/);
  });

  test('repair file-drift --since parses to the instant the preview and apply command carry, and narrows only --all-drifted', async () => {
    const parsed = parseRepairArgs(['file-drift', '--source', 'default', '--all-drifted', '--since', '7d', '--prefer', 'database']);
    expect(parsed.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(parsed.since!) - (Date.now() - 7 * 86_400_000))).toBeLessThan(60_000);
    expect(() => parseRepairArgs(['file-drift', '--source', 'default', '--all-drifted', '--since', 'last week'])).toThrow(/could not parse/);
    expect(() => parseRepairArgs(['frontmatter', '--since', '7d'])).toThrow();
    const scope = { brain_id: 'b', source_ids: ['default'] } as never;
    await expect(fileDriftRepair.plan({} as BrainEngine, scope, null, { apply: false, remote: false, prefer: 'database', slugs: ['notes/a'], since: parsed.since }))
      .rejects.toThrow('--since only narrows --all-drifted');
  });
});

for (const backend of testBackends()) describe(`#6712 PR 2 L4 holds and soak counters (${backend})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  let incarnation: string;
  const source = `l4-${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    if (backend === 'pglite') { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }
    else { const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase()); engine = pg.engine; close = pg.close; }
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [source]);
    incarnation = (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [source]))[0]!.incarnation;
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });

  let observed = 0;
  const hold = (path: string, code: GitHoldRecord['code'], meta: Partial<GitHoldRecord['meta']> = {}): Omit<GitHoldRecord, 'version' | 'held_at' | 'updated_at'> => ({
    source_id: source, incarnation, path, source_path: path, slug: path.replace(/\.md$/, ''), page_id: null, code, message: `${path} held`, upstream_version: `v-${path}`,
    observed_at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + ++observed * 1000).toISOString(), run_id: 'run-1', mode: 'managed', meta: { recovery_version: 1, ...meta } });
  const read = async (path: string) => (await readGitHold(engine, source, incarnation, path))!;
  const verdict = (record: GitHoldRecord, now?: number) => classifySyncFault({ code: record.code, ...holdEscalation(record, now) });

  test('escalation needs failed attempts AND a day since the path was first held; a live editor and an image never escalate', async () => {
    await writeGitHold(engine, hold('stalled.md', 'preparation_stalled'));
    const first = await read('stalled.md');
    expect(first.meta).toMatchObject({ attempts: 1, first_held_at: first.held_at });
    for (let attempt = 2; attempt <= HOLD_ATTEMPTS_NEEDS_HUMAN; attempt++) await writeGitHold(engine, hold('stalled.md', 'preparation_stalled'));
    const stalled = await read('stalled.md');
    expect(stalled.meta).toMatchObject({ attempts: HOLD_ATTEMPTS_NEEDS_HUMAN, first_held_at: first.held_at });
    // Three re-holds within seconds: the safe action is not exhausted yet.
    expect(verdict(stalled)).toMatchObject({ needs_human: false, safe_actions: ['retry', 'upgrade'] });
    // The same three attempts a day after the first hold: a person is named, with both numbers.
    const later = Date.parse(first.held_at) + HOLD_ESCALATE_MS + 60_000;
    expect(verdict(stalled, later)).toMatchObject({ needs_human: true, safe_actions: ['none'], human_reason: expect.stringContaining(`held ${HOLD_ATTEMPTS_NEEDS_HUMAN} times over 24 h`) });

    // A worktree_dirty hold whose uncommitted bytes keep changing is a live editor; a failed unblock that saw new bytes restarts its clock.
    await writeGitHold(engine, hold('dirty.md', 'worktree_dirty', { working_hash: 'h1' }));
    expect(await recordHoldAttempt(engine, { sourceId: source, incarnation, path: 'dirty.md', code: 'worktree_dirty', workingHash: 'h1' })).toBe(true);
    expect(await recordHoldAttempt(engine, { sourceId: source, incarnation, path: 'dirty.md', code: 'worktree_dirty', workingHash: 'h1' })).toBe(true);
    const dirty = await read('dirty.md');
    expect(dirty.meta).toMatchObject({ attempts: 3, working_hash: 'h1', edited_at: dirty.held_at });
    expect(holdEscalation(dirty).live_editor).toBe(true);
    expect(verdict(dirty, Date.parse(dirty.held_at) + HOLD_ESCALATE_MS + 60_000)).toMatchObject({ needs_human: true });
    expect(await recordHoldAttempt(engine, { sourceId: source, incarnation, path: 'dirty.md', code: 'worktree_dirty', workingHash: 'h2' })).toBe(true);
    const edited = await read('dirty.md');
    expect(edited.meta).toMatchObject({ attempts: 4, working_hash: 'h2', first_held_at: dirty.meta.first_held_at });
    expect(Date.parse(edited.meta.edited_at!)).toBeGreaterThan(Date.parse(dirty.meta.edited_at!));
    // First held two days ago, edited just now: still a live editor, never escalated.
    const old = { ...edited, meta: { ...edited.meta, first_held_at: new Date(Date.now() - 2 * HOLD_ESCALATE_MS).toISOString() } };
    expect(holdEscalation(old)).toMatchObject({ attempts: 4, live_editor: true });
    expect(verdict(old)).toMatchObject({ needs_human: false, safe_actions: ['retry_when_clean'] });
    // An attempt on a path that holds another code by now changes nothing.
    expect(await recordHoldAttempt(engine, { sourceId: source, incarnation, path: 'dirty.md', code: 'invalid_frontmatter' })).toBe(false);

    await writeGitHold(engine, hold('photo.png', 'managed_image_sync_unsupported'));
    for (let i = 0; i < 4; i++) await writeGitHold(engine, hold('photo.png', 'managed_image_sync_unsupported'));
    expect(verdict(await read('photo.png'), Date.now() + 9 * HOLD_ESCALATE_MS)).toMatchObject({ needs_human: false });
  });

  test('an attempt that races a newer hold leaves the newer hold as written (it never restores the record it read)', async () => {
    await writeGitHold(engine, hold('race.md', 'preparation_stalled'));
    let raced = false;
    // Another run re-holds the path between this attempt's read and its write.
    const racing = new Proxy(engine, { get: (target, key) => key !== 'executeRaw' ? Reflect.get(target, key) : async (sql: string, params?: unknown[]) => {
      if (!raced && /^\s*UPDATE op_checkpoints/.test(sql)) { raced = true; await writeGitHold(engine, { ...hold('race.md', 'invalid_frontmatter'), message: 'newer' }); }
      return engine.executeRaw(sql, params);
    } }) as BrainEngine;
    expect(await recordHoldAttempt(racing, { sourceId: source, incarnation, path: 'race.md', code: 'preparation_stalled' })).toBe(false);
    expect(raced).toBe(true);
    expect(await read('race.md')).toMatchObject({ code: 'invalid_frontmatter', message: 'newer', meta: { attempts: 1 } });
  });

  test('the soak sweep counts a hold that needs a person once (file_drift as a content decision); counters sum per day and doctor reports both lines', async () => {
    const before = await readSoakCounters(engine);
    await writeGitHold(engine, hold('race.md', 'concurrent_write'));
    await writeGitHold(engine, hold('drift.md', 'file_drift', { sides: 'database' }));
    await writeGitHold(engine, hold('fresh-dirty.md', 'worktree_dirty', { working_hash: 'x' }));
    const first = await sweepNeedsHumanHolds(engine, source);
    // preparation_stalled from the test above is not escalated yet (three attempts within seconds).
    expect(first).toEqual({ needs_human: 1, file_drift_hold: 1 });
    expect((await read('race.md')).meta.needs_human_at).toBeDefined();
    // Re-held with the same code: the stamp survives, so the hold is not counted again.
    await writeGitHold(engine, hold('race.md', 'concurrent_write'));
    expect((await read('race.md')).meta.needs_human_at).toBeDefined();
    expect(await sweepNeedsHumanHolds(engine, source)).toEqual({ needs_human: 0, file_drift_hold: 0 });
    // A day later the stalled and dirty holds' attempts escalate (nobody edited dirty.md since): counted then, once each.
    const dayLater = Date.now() + HOLD_ESCALATE_MS + 60_000;
    expect(await sweepNeedsHumanHolds(engine, source, dayLater)).toEqual({ needs_human: 2, file_drift_hold: 0 });
    expect(await sweepNeedsHumanHolds(engine, source, dayLater)).toEqual({ needs_human: 0, file_drift_hold: 0 });
    await recordSoakEvent(engine, 'sync_non_plain');
    await recordSoakEvent(engine, 'file_drift_apply');
    const after = await readSoakCounters(engine);
    expect(after.interventions.needs_human - before.interventions.needs_human).toBe(3);
    expect(after.interventions.sync_non_plain - before.interventions.sync_non_plain).toBe(1);
    expect(after.interventions.total - before.interventions.total).toBe(4);
    expect(after.content_decisions.file_drift_hold - before.content_decisions.file_drift_hold).toBe(1);
    expect(after.content_decisions.file_drift_apply - before.content_decisions.file_drift_apply).toBe(1);
    expect(after.content_decisions.total - before.content_decisions.total).toBe(2);
    expect(after.by_day.at(-1)).toMatchObject({ day: new Date().toISOString().slice(0, 10) });
    const [check] = await soakCountersEntry.run({ engine, progress: { heartbeat() {} } } as never) as unknown as Array<Record<string, any>>;
    expect(check).toMatchObject({ name: 'sync_soak_counters', status: 'ok', severity: 'info',
      details: { window_days: 7, interventions: { total: after.interventions.total }, content_decisions: { total: after.content_decisions.total } } });
    expect(check!.message).toContain('content decision(s)');
  });

  test('the sweep counts what status calls needs_human (a manual fence) and is never starved by holds that stay the agent\'s', async () => {
    const other = `l4b-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [other]);
    const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [other]);
    const put = (path: string, code: GitHoldRecord['code'], meta: Partial<GitHoldRecord['meta']> = {}) => writeGitHold(engine, { ...hold(path, code, meta), source_id: other, incarnation: row!.incarnation });
    // 501 agent-actionable holds sort before the two that need a person.
    for (let i = 0; i <= 500; i++) await put(`a/${String(i).padStart(3, '0')}.md`, 'invalid_frontmatter');
    await put('z/fence.md', 'invalid_fence', { reason: 'enum_unmapped' });
    await put('z/race.md', 'concurrent_write');
    expect(await sweepNeedsHumanHolds(engine, other)).toEqual({ needs_human: 2, file_drift_hold: 0 });
    expect(await sweepNeedsHumanHolds(engine, other)).toEqual({ needs_human: 0, file_drift_hold: 0 });
  }, 120_000);

  test('a plain scheduler run is not an intervention; a recovery flag is', () => {
    expect(nonPlainSyncFlags(['--all', '--no-pull', '--hard-deadline', '13m', '--json'])).toEqual([]);
    expect(nonPlainSyncFlags(['--source', 'default', '--no-pull', '--no-embed', '--no-lanes', '--no-bulk'])).toEqual([]);
    expect(nonPlainSyncFlags(['--source', 'default', '--retry-failed', '--full'])).toEqual(['--retry-failed', '--full']);
    expect(nonPlainSyncFlags(['--break-lock', '--max-age', '60s'])).toEqual(['--break-lock']);
  });
});

describe('#6712 PR 2 L4: ghost pages after a managed sync', () => {
  const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
  test('a page whose file left the checkout is counted with the repair ghost-pages preview, and sync never deletes it', () => managedBrain(async ({ engine, ctx, root }) => {
    const sync = () => performSync(engine, { repoPath: root, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
    for (const slug of ['notes/kept', 'notes/gone']) {
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${slug}\n---\n\n${slug} body.\n` } });
    }
    await disposePersistenceConsumer(engine);
    const clean = await sync();
    expect(clean.ghostPages).toBeUndefined();
    unlinkSync(join(root, 'notes/gone.md'));
    const result = await sync();
    expect(result.ghostPages).toMatchObject({ count: 1, truncated: false, samples: ['notes/gone'],
      fix: { argv: ['gbrain', 'repair', 'ghost-pages', '--source', 'default'], actor: 'agent', consent: [] } });
    expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id='default' AND slug='notes/gone' AND deleted_at IS NULL"))[0]!.n).toBe(1);
    expect(await countSyncGhosts(engine, 'default')).toMatchObject({ count: 1 });
  }, { setup }), 120_000);
});
