/**
 * GBRA-582 item 9 (leaver handover, PR 2): \`gbrain access member handover\` gives a disabled member's pages to someone
 * who still reads them.
 *
 * 1. Protects: the preview groups the leaver's pages (kept, folder, shared, source, memory) and names who gains and
 *    loses; the apply writes exactly the approved items through the label and rule doors, records them on an
 *    access_handovers row, and leaves no page of the leaver readable by no member; --set changes a group's target;
 *    undo restores each recorded list once the member is enabled again. Refusals write nothing.
 * 2. Fails when: a kept page stays readable by nobody, a shared page loses a reader under the default, the member page
 *    changes, the owner's reads shrink, an apply writes something the preview did not show, or undo does not restore.
 * 3. Existing coverage: access-read-by-nobody-gbra593 pins the messages; readers-label-setter pins the label door.
 * 4. Real seams: the access CLI module on PGLite and Postgres, repo-less (database rule store).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAccess, whoCanRead } from '../src/commands/access.ts';
import { addMember } from '../src/core/access/members.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { addFolderRules, currentFolderRules, writeApprovedRules } from '../src/commands/access-rules.ts';
import { handoverCmd } from '../src/commands/access-handover.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { operationsByName } from '../src/core/operations.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'default';

async function access(engine: BrainEngine, args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try {
    if (args[0] === 'member' && args[1] === 'handover') await handoverCmd(engine, args.slice(2), args.includes('--json'));
    else await runAccess(engine, args);
  } finally { spy.mockRestore(); }
  return lines.join('\n');
}

const json = async <T>(engine: BrainEngine, args: string[]) => JSON.parse(await access(engine, [...args, '--json'])) as T;

/** The refusal a handover call throws. */
async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (e) { if (e instanceof OperationError) return e; throw e; }
  throw new Error('expected a refusal');
}

const readers = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ r: unknown }>(
  "SELECT frontmatter->'readable_by' AS r FROM pages WHERE source_id = $1 AND slug = $2", [SRC, slug]))[0]?.r ?? null;

async function readersOf(engine: BrainEngine, slug: string): Promise<string[] | 'every_source_reader'> {
  const [entry] = await whoCanRead(engine, slug, SRC);
  return entry!.members as string[] | 'every_source_reader';
}

const SLUGS = ['notes/bob-private-example', 'notes/two-leavers-example', 'notes/team-a-example', 'calls/sync-example', 'notes/team-b-example',
  'people/bob-example/journal', 'people/bob-example/plan', 'open/handbook-example', 'memory/members/bob-example'];

type Write = (slug: string, content: string) => Promise<unknown>;

async function fixture(engine: BrainEngine, write: Write = (slug, content) => importFromContent(engine, slug, content, { sourceId: SRC })): Promise<void> {
  for (const id of ['owner-example', 'alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
  await addMember(engine, 'room-example', { kind: 'audience', remote: false } as never);
  await engine.setConfig('access.owner_member', 'owner-example');
  await access(engine, ['group', 'add', 'team-a', '--members', 'bob-example']);
  await access(engine, ['group', 'add', 'team-b', '--members', 'bob-example,alice-example']);
  const page = (slug: string, r?: string[]) => write(slug,
    '---\ntype: note\ntitle: ' + slug + '\n' + (r ? 'readable_by: [' + r.join(', ') + ']\n' : '') + '---\nSynthetic notes.\n');
  await page('notes/bob-private-example', ['bob-example']);
  await page('notes/two-leavers-example', ['bob-example', 'carol-example']);
  await page('notes/team-a-example', ['group:team-a']);
  await page('calls/sync-example', ['bob-example', 'alice-example', 'owner-example']);
  await page('notes/team-b-example', ['group:team-b']);
  await page('people/bob-example/journal');
  await page('people/bob-example/plan', ['bob-example']);
  await page('open/handbook-example');
  await page('memory/members/bob-example', ['bob-example']);
  await addFolderRules(engine, SRC, [{ id: 'bob-folder', prefix: 'people/bob-example/', readable_by: ['member:bob-example'] } as never], { apply: true, json: true });
  await access(engine, ['member', 'disable', 'carol-example']);
}

interface Preview { plan_hash: string; items: Array<{ kind: string; group: string; slug?: string; to: string[] | null }>; groups: Array<{ group: string; count: number; sample: string[] }>; gains: string[]; losses: string[] }
interface Record { id: string; state: string; items: Array<{ outcome: string }>; undo_of: string | null }

async function cases(engine: BrainEngine): Promise<void> {
  const memberPage = await engine.executeRaw('SELECT frontmatter, compiled_truth FROM pages WHERE slug = $1', ['memory/members/bob-example']);
  const ownerBefore: string[] = [];
  for (const slug of SLUGS) { const r = await readersOf(engine, slug); if (r === 'every_source_reader' || r.includes('owner-example')) ownerBefore.push(slug); }

  const enabled = await refusal(() => access(engine, ['member', 'handover', 'bob-example']));
  expect(enabled.code).toBe('handover_member_enabled');
  await access(engine, ['member', 'disable', 'bob-example']);

  const audience = await refusal(() => access(engine, ['member', 'handover', 'bob-example', '--set', 'kept=room-example']));
  expect([audience.code, audience.reason]).toEqual(['access_member_invalid', 'audience_target']);
  const disabledTarget = await refusal(() => access(engine, ['member', 'handover', 'bob-example', '--set', 'kept=carol-example']));
  expect(disabledTarget.code).toBe('access_member_invalid');

  const p = await json<Preview>(engine, ['member', 'handover', 'bob-example']);
  const group = (g: string) => p.groups.find(x => x.group === g)!;
  expect(group('kept').count).toBe(3);
  expect(group('folder').count).toBe(2);
  expect(group('shared').count).toBe(2);
  expect(group('memory').count).toBe(1);
  expect(p.items.filter(i => i.group === 'shared')).toEqual([]);
  expect(p.gains).toEqual(['owner-example']);
  expect(p.losses).toEqual([]);
  for (const slug of SLUGS) expect(await readers(engine, slug)).toBeDefined();
  expect(await readersOf(engine, 'notes/bob-private-example')).toEqual([]);

  const stale = await refusal(() => access(engine, ['member', 'handover', 'bob-example', '--yes', '--expect', 'not-the-hash']));
  expect(stale.code).toBe('preview_changed');

  const applied = await json<Record>(engine, ['member', 'handover', 'bob-example', '--yes', '--expect', p.plan_hash]);
  expect(applied.state).toBe('applied');
  expect(applied.items.every(i => i.outcome === 'done')).toBe(true);
  for (const slug of ['notes/bob-private-example', 'notes/two-leavers-example', 'notes/team-a-example', 'people/bob-example/journal', 'people/bob-example/plan']) {
    expect(await readersOf(engine, slug)).toEqual(['owner-example']);
  }
  expect(await readersOf(engine, 'calls/sync-example')).toEqual(['alice-example', 'owner-example']);
  expect(await readers(engine, 'calls/sync-example')).toEqual(['bob-example', 'alice-example', 'owner-example']);
  expect(await engine.executeRaw('SELECT frontmatter, compiled_truth FROM pages WHERE slug = $1', ['memory/members/bob-example'])).toEqual(memberPage);
  for (const slug of ownerBefore) { const r = await readersOf(engine, slug); expect(r === 'every_source_reader' || r.includes('owner-example')).toBe(true); }

  const again = await json<Record>(engine, ['member', 'handover', 'bob-example', '--yes', '--expect', p.plan_hash]);
  expect(again.id).toBe(applied.id);
  const status = await json<Record>(engine, ['member', 'handover', '--status', applied.id]);
  expect(status.state).toBe('applied');

  const undoDisabled = await refusal(() => access(engine, ['member', 'handover', 'bob-example', '--undo', applied.id]));
  expect([undoDisabled.code, undoDisabled.reason]).toEqual(['handover_undo_member_disabled', 'disabled']);

  await access(engine, ['member', 'enable', 'bob-example']);
  await importFromContent(engine, 'notes/two-leavers-example', '---\ntype: note\ntitle: edited\nreadable_by: [alice-example]\n---\nEdited since.\n', { sourceId: SRC });
  const undo = await json<{ plan_hash: string; items: unknown[]; changed_since: number }>(engine, ['member', 'handover', 'bob-example', '--undo', applied.id]);
  expect(undo.changed_since).toBe(1);
  const undone = await json<Record>(engine, ['member', 'handover', 'bob-example', '--undo', applied.id, '--yes', '--expect', undo.plan_hash]);
  expect(undone.undo_of).toBe(applied.id);
  expect(await readers(engine, 'notes/bob-private-example')).toEqual(['bob-example']);
  expect(await readers(engine, 'notes/team-a-example')).toEqual(['group:team-a']);
  expect(await readersOf(engine, 'people/bob-example/journal')).toEqual(['bob-example']);
  expect(await readers(engine, 'notes/two-leavers-example')).toEqual(['alice-example']);
  const original = await json<Record>(engine, ['member', 'handover', '--status', applied.id]);
  expect(original.state).toBe('undone');
  expect((await refusal(() => access(engine, ['member', 'handover', 'bob-example', '--undo', applied.id]))).code).toBe('invalid_params');

  await access(engine, ['member', 'disable', 'bob-example']);
  const choices = await json<Preview>(engine, ['member', 'handover', 'bob-example', '--set', 'kept=alice-example', '--set', 'shared=drop', '--set', 'folder=everyone']);
  expect(choices.items.find(i => i.slug === 'notes/bob-private-example')!.to).toEqual(['alice-example', 'owner-example']);
  expect(choices.items.find(i => i.slug === 'calls/sync-example')!.to).toEqual(['alice-example', 'owner-example']);
  expect(choices.items.find(i => i.kind === 'rule')!.to).toBeNull();
  await json<Record>(engine, ['member', 'handover', 'bob-example', '--set', 'kept=alice-example', '--set', 'shared=drop', '--set', 'folder=everyone', '--yes', '--expect', choices.plan_hash]);
  expect(await readersOf(engine, 'notes/bob-private-example')).toEqual(['alice-example', 'owner-example']);
  expect(await readers(engine, 'calls/sync-example')).toEqual(['alice-example', 'owner-example']);
  expect(await readersOf(engine, 'people/bob-example/journal')).toBe('every_source_reader');
}

/** A default handover after an undo is a new plan: it writes again instead of returning the undone row. */
async function reapplyAfterUndo(engine: BrainEngine): Promise<void> {
  await addMember(engine, 'dana-example');
  await importFromContent(engine, 'notes/dana-example', '---\ntype: note\ntitle: dana\nreadable_by: [dana-example]\n---\nSynthetic.\n', { sourceId: SRC });
  await access(engine, ['member', 'disable', 'dana-example']);
  const first = await json<Preview>(engine, ['member', 'handover', 'dana-example']);
  const applied = await json<Record>(engine, ['member', 'handover', 'dana-example', '--yes', '--expect', first.plan_hash]);
  await access(engine, ['member', 'enable', 'dana-example']);
  const undo = await json<{ plan_hash: string }>(engine, ['member', 'handover', 'dana-example', '--undo', applied.id]);
  await json<Record>(engine, ['member', 'handover', 'dana-example', '--undo', applied.id, '--yes', '--expect', undo.plan_hash]);
  expect(await readers(engine, 'notes/dana-example')).toEqual(['dana-example']);
  await access(engine, ['member', 'disable', 'dana-example']);
  const second = await json<Preview>(engine, ['member', 'handover', 'dana-example']);
  expect(second.plan_hash).not.toBe(first.plan_hash);
  const again = await json<Record>(engine, ['member', 'handover', 'dana-example', '--yes', '--expect', second.plan_hash]);
  expect(again.id).not.toBe(applied.id);
  expect(again.state).toBe('applied');
  expect(await readersOf(engine, 'notes/dana-example')).toEqual(['owner-example']);
}

/** Resuming a handover refuses while another folder-rule change waits for approval, so it never approves that change. */
async function resumeWithHeldRule(engine: BrainEngine): Promise<void> {
  await addMember(engine, 'frank-example');
  await addFolderRules(engine, SRC, [{ id: 'frank-folder', prefix: 'people/frank-example/', readable_by: ['member:frank-example'] } as never], { apply: true, json: true });
  await importFromContent(engine, 'people/frank-example/plan', '---\ntype: note\ntitle: plan\n---\nSynthetic.\n', { sourceId: SRC });
  await addFolderRules(engine, SRC, [{ id: 'held-folder', prefix: 'held/', readable_by: ['member:owner-example'] } as never], { apply: true, json: true });
  await importFromContent(engine, 'held/page-example', '---\ntype: note\ntitle: held\n---\nSynthetic.\n', { sourceId: SRC });
  await access(engine, ['member', 'disable', 'frank-example']);
  const p = await json<Preview>(engine, ['member', 'handover', 'frank-example']);
  expect(p.items.some(i => i.kind === 'rule')).toBe(true);
  const applied = await json<Record>(engine, ['member', 'handover', 'frank-example', '--yes', '--expect', p.plan_hash]);
  const [row] = await engine.executeRaw<{ items: unknown }>('SELECT items FROM access_handovers WHERE id = $1', [applied.id]);
  const items = (typeof row!.items === 'string' ? JSON.parse(row!.items) : row!.items) as Array<{ kind: string; outcome?: string }>;
  for (const item of items) if (item.kind === 'rule') delete item.outcome;
  await engine.executeRaw("UPDATE access_handovers SET state = 'applying', items = $2::text::jsonb WHERE id = $1", [applied.id, JSON.stringify(items)]);
  await addFolderRules(engine, SRC, [{ id: 'held-folder', prefix: 'held/', readable_by: ['member:owner-example', 'member:alice-example'] } as never], { apply: true, json: true });
  expect(await readersOf(engine, 'held/page-example')).toEqual(['owner-example']);
  const resumed = await refusal(() => access(engine, ['member', 'handover', 'frank-example', '--yes', '--expect', p.plan_hash]));
  expect(resumed.code).toBe('handover_rules_held');
  expect(await readersOf(engine, 'held/page-example')).toEqual(['owner-example']);
}

async function noOwner(engine: BrainEngine): Promise<void> {
  await addMember(engine, 'erin-example');
  await importFromContent(engine, 'notes/erin-example', '---\ntype: note\ntitle: erin\nreadable_by: [erin-example]\n---\nSynthetic.\n', { sourceId: SRC });
  await access(engine, ['member', 'disable', 'erin-example']);
  await engine.executeRaw("DELETE FROM config WHERE key = 'access.owner_member'").catch(() => undefined);
  const e = await refusal(() => access(engine, ['member', 'handover', 'erin-example']));
  expect(e.code).toBe('handover_owner_unset');
  const keep = await json<Preview>(engine, ['member', 'handover', 'erin-example', '--set', 'kept=keep', '--set', 'folder=keep']);
  expect(keep.items).toEqual([]);
}

/** The approved set and the handover row belong to the member they were previewed for: another member's apply refuses. */
async function memberBinding(engine: BrainEngine): Promise<void> {
  await engine.setConfig('access.owner_member', 'owner-example');
  for (const id of ['gina-example', 'hank-example']) await addMember(engine, id);
  await importFromContent(engine, 'notes/gina-example', '---\ntype: note\ntitle: gina\nreadable_by: [gina-example]\n---\nSynthetic.\n', { sourceId: SRC });
  await access(engine, ['member', 'disable', 'gina-example']);
  await access(engine, ['member', 'disable', 'hank-example']);
  const p = await json<Preview>(engine, ['member', 'handover', 'gina-example']);
  expect(p.items.length).toBeGreaterThan(0);
  const rows = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM access_handovers'))[0]!.n;
  const before = await rows();
  const other = await refusal(() => access(engine, ['member', 'handover', 'hank-example', '--yes', '--expect', p.plan_hash]));
  expect(other.code).toBe('preview_changed');
  expect(await readers(engine, 'notes/gina-example')).toEqual(['gina-example']);
  expect(await rows()).toBe(before);
  await access(engine, ['member', 'enable', 'gina-example']);
  const reEnabled = await refusal(() => access(engine, ['member', 'handover', 'hank-example', '--yes', '--expect', p.plan_hash]));
  expect(reEnabled.code).toBe('preview_changed');
  expect(await readers(engine, 'notes/gina-example')).toEqual(['gina-example']);
  await access(engine, ['member', 'disable', 'gina-example']);
  const applied = await json<Record>(engine, ['member', 'handover', 'gina-example', '--yes', '--expect', p.plan_hash]);
  expect(applied.state).toBe('applied');
  const resumedByOther = await refusal(() => access(engine, ['member', 'handover', 'hank-example', '--yes', '--expect', p.plan_hash]));
  expect(resumedByOther.code).toBe('preview_changed');
}

/** A folder rule whose prefix moved after the preview, under the same id and readers, is never rewritten at its new prefix. */
async function rulePrefixMoved(engine: BrainEngine): Promise<void> {
  await engine.setConfig('access.owner_member', 'owner-example');
  await addMember(engine, 'ivy-example');
  const rule = (prefix: string) => addFolderRules(engine, SRC, [{ id: 'ivy-folder', prefix, readable_by: ['member:ivy-example'] } as never], { apply: true, json: true });
  const move = async (prefix: string) => writeApprovedRules(engine, SRC, (await currentFolderRules(engine, SRC)).map(r => r.id === 'ivy-folder' ? { ...r, prefix, readable_by: ['member:ivy-example'] } : r), 'access: move ivy-folder to ' + prefix);
  const ruleNow = async () => (await engine.executeRaw<{ prefix: string; readable_by: string[] }>('SELECT prefix, readable_by FROM access_rules WHERE source_id = $1 AND rule_id = $2', [SRC, 'ivy-folder']))[0];
  await rule('people/ivy-example/');
  await importFromContent(engine, 'people/ivy-example/plan', '---\ntype: note\ntitle: plan\n---\nSynthetic.\n', { sourceId: SRC });
  await importFromContent(engine, 'moved-ivy/page-example', '---\ntype: note\ntitle: moved\n---\nSynthetic.\n', { sourceId: SRC });
  await access(engine, ['member', 'disable', 'ivy-example']);
  const p = await json<Preview>(engine, ['member', 'handover', 'ivy-example']);
  expect(p.items.some(i => i.kind === 'rule')).toBe(true);
  await move('moved-ivy/');
  const fresh = await refusal(() => access(engine, ['member', 'handover', 'ivy-example', '--yes', '--expect', p.plan_hash]));
  expect(fresh.code).toBe('preview_changed');
  expect(await ruleNow()).toEqual({ prefix: 'moved-ivy/', readable_by: ['member:ivy-example'] });

  await move('people/ivy-example/');
  const applied = await json<Record>(engine, ['member', 'handover', 'ivy-example', '--yes', '--expect', p.plan_hash]);
  const [row] = await engine.executeRaw<{ items: unknown }>('SELECT items FROM access_handovers WHERE id = $1', [applied.id]);
  const items = (typeof row!.items === 'string' ? JSON.parse(row!.items) : row!.items) as Array<{ kind: string; outcome?: string }>;
  for (const item of items) if (item.kind === 'rule') delete item.outcome;
  await engine.executeRaw("UPDATE access_handovers SET state = 'applying', items = $2::text::jsonb WHERE id = $1", [applied.id, JSON.stringify(items)]);
  await move('moved-ivy/');
  const resumed = await refusal(() => access(engine, ['member', 'handover', 'ivy-example', '--yes', '--expect', p.plan_hash]));
  expect(resumed.code).toBe('preview_changed');
  expect(await ruleNow()).toEqual({ prefix: 'moved-ivy/', readable_by: ['member:ivy-example'] });
}

/** An undo approval belongs to the handover it was previewed for: naming another handover of the same member refuses. */
async function undoBinding(engine: BrainEngine): Promise<void> {
  await engine.setConfig('access.owner_member', 'owner-example');
  await addMember(engine, 'jo-example');
  const page = (slug: string) => importFromContent(engine, slug, '---\ntype: note\ntitle: jo\nreadable_by: [jo-example]\n---\nSynthetic.\n', { sourceId: SRC });
  await page('notes/jo-first-example');
  await access(engine, ['member', 'disable', 'jo-example']);
  const first = await json<Preview>(engine, ['member', 'handover', 'jo-example']);
  const h1 = await json<Record>(engine, ['member', 'handover', 'jo-example', '--yes', '--expect', first.plan_hash]);
  await access(engine, ['member', 'enable', 'jo-example']);
  await page('notes/jo-second-example');
  await access(engine, ['member', 'disable', 'jo-example']);
  const second = await json<Preview>(engine, ['member', 'handover', 'jo-example']);
  const h2 = await json<Record>(engine, ['member', 'handover', 'jo-example', '--yes', '--expect', second.plan_hash]);
  expect(h2.id).not.toBe(h1.id);
  await access(engine, ['member', 'enable', 'jo-example']);
  const undo1 = await json<{ plan_hash: string }>(engine, ['member', 'handover', 'jo-example', '--undo', h1.id]);
  const crossed = await refusal(() => access(engine, ['member', 'handover', 'jo-example', '--undo', h2.id, '--yes', '--expect', undo1.plan_hash]));
  expect(crossed.code).toBe('preview_changed');
  expect(await readers(engine, 'notes/jo-first-example')).toEqual(['owner-example']);
  expect((await json<Record>(engine, ['member', 'handover', '--status', h2.id])).state).toBe('applied');
  const undone = await json<Record>(engine, ['member', 'handover', 'jo-example', '--undo', h1.id, '--yes', '--expect', undo1.plan_hash]);
  expect(undone.undo_of).toBe(h1.id);
  expect(await readers(engine, 'notes/jo-first-example')).toEqual(['jo-example']);
}

for (const backend of testBackends()) {
  describe('member handover on a repo-less brain (' + backend + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({ engine: 'pglite' } as never); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      await fixture(engine);
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('preview, apply, resume, status, undo and --set choices', () => cases(engine), 180_000);
    test('a default handover after an undo applies again', () => reapplyAfterUndo(engine), 120_000);
    test('a resumed handover refuses while another rule change is held', () => resumeWithHeldRule(engine), 120_000);
    test('a brain with no owner refuses the default and allows keep', () => noOwner(engine), 60_000);
    test("another member's apply of an approved handover refuses", () => memberBinding(engine), 120_000);
    test('a folder rule moved to a new prefix after the preview is never rewritten', () => rulePrefixMoved(engine), 120_000);
    test('an undo approval applies only to the handover it was previewed for', () => undoBinding(engine), 120_000);
  });

  describe('member handover on a managed git source (' + backend + ')', () => {
    const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
    const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), 'archive/\n'); durableGitRepo(root, ['.gitignore']); };

    test('page files and the rule file are committed; the row settles from publishing to applied', () => managedBrain(async ({ engine, ctx, root }) => {
      await fixture(engine, async (slug, content) => {
        expect(await operationsByName.put_page!.handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
      });
      await settleManagedGitEffects(engine);
      await access(engine, ['member', 'disable', 'bob-example']);
      const p = await json<Preview>(engine, ['member', 'handover', 'bob-example']);
      const applied = await json<Record & { commits: string[] }>(engine, ['member', 'handover', 'bob-example', '--yes', '--expect', p.plan_hash]);
      expect(['publishing', 'applied']).toContain(applied.state);
      expect(applied.commits.length).toBeGreaterThan(0);
      await settleManagedGitEffects(engine);
      const status = await json<Record>(engine, ['member', 'handover', '--status', applied.id]);
      expect(status.state).toBe('applied');
      expect(readFileSync(join(root, 'notes/bob-private-example.md'), 'utf8')).toContain('readable_by: [owner-example]');
      expect(readFileSync(join(root, '.gbrain', 'access.yml'), 'utf8')).toContain('owner-example');
      expect(await readersOf(engine, 'people/bob-example/journal')).toEqual(['owner-example']);
    }, { databaseUrl, setup }), 240_000);
  });
}
