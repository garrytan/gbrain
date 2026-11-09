/**
 * gbrain repair private-labels: classify the privacy labels live pages carry
 * into KEEP (a real restriction) and CLEAR (an over-stamped access: private),
 * and clear the CLEAR ones through revision-bound page writes, reversibly.
 *
 * 1. Protects: only alias and alias-and-visibility pages lose their label;
 *    restricted, confidential, explicit, pinned-question and derived pages keep
 *    theirs byte for byte; a git-canonical source's pages wait for
 *    --class git-publish; a bare --apply clears nothing; a page edited since the
 *    preview is skipped; --class restore puts back exactly what was removed.
 * 2. Fails when: a keep page changes, the body or another key changes, the
 *    ledger misses a line or an original value, or restore re-adds something
 *    other than the recorded value.
 * 3. Real seams: repo-less PGLite, the registered handler driven through the
 *    gbrain repair command entry (argument parse, runner, runRepair).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { EXPLICIT_REPAIR_REGISTRY, PREVIEW_BOUND_REPAIR_REGISTRY, repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { classifyPrivateLabel } from '../src/core/repair/private-labels.ts';
import { withEnv } from './helpers/with-env.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-private-labels-'));
const GIT_SOURCE = 'source-a';
const NL = String.fromCharCode(10);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log;
  console.log = (...parts: unknown[]) => { printed += parts.map(String).join(' ') + NL; };
  try { await fn(); } finally { console.log = original; }
  return printed;
}

const run = (argv: string[]) => withEnv({ GBRAIN_HOME: dir, GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() => runRepairCommand(engine, argv)));
const json = async (argv: string[]) => { const out = JSON.parse(await run([...argv, '--json'])).results[0]; _resetCliExitVerdictForTests(); return out; };
const ledgerPath = (brainId: string) => join(dir, '.gbrain', 'repair', 'private-labels', brainId + '.jsonl');
const ledgerLines = (brainId: string) => readFileSync(ledgerPath(brainId), 'utf8').trim().split(NL).map(line => JSON.parse(line));

async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const SEEDS: Array<{ slug: string; type: string; frontmatter: Record<string, unknown>; source?: string }> = [
  { slug: 'notes/alias', type: 'note', frontmatter: { access: 'private', status: 'draft' } },
  { slug: 'notes/readers', type: 'note', frontmatter: { access: 'private', readable_by: ['alice-example'] } },
  { slug: 'notes/alias-vis', type: 'note', frontmatter: { access: 'Private', visibility: 'private', topic: 'research' } },
  { slug: 'notes/restricted', type: 'note', frontmatter: { access: 'restricted' } },
  { slug: 'notes/secret', type: 'note', frontmatter: { access: 'private', confidentiality: 'secret' } },
  { slug: 'notes/explicit', type: 'note', frontmatter: { visibility: 'private' } },
  { slug: 'questions/pinned', type: 'note', frontmatter: { pinned_question: true, access: 'private' } },
  { slug: 'atoms/a', type: 'atom', frontmatter: { access: 'private', source_slug: 'notes/plain' } },
  { slug: 'notes/plain', type: 'note', frontmatter: {} },
  { slug: 'notes/a', type: 'note', frontmatter: { access: 'private' }, source: GIT_SOURCE },
];
const KEEP = ['notes/restricted', 'notes/secret', 'notes/explicit', 'questions/pinned', 'atoms/a', 'notes/plain'];
const ALL_CLEARED = { pinned_question: 1, derived: 1, strong_alias: 2, explicit_visibility: 1, alias: 0, 'alias-and-visibility': 0, 'git-publish': 1 };

interface Row { frontmatter: Record<string, unknown>; compiled_truth: string; revision: string; page_id: number }
async function row(slug: string, source = 'default'): Promise<Row> {
  const [r] = await engine.executeRaw<Row>('SELECT frontmatter, compiled_truth, knowledge_revision::text AS revision, id AS page_id '
    + 'FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [source, slug]);
  return r!;
}

const body = (slug: string) => slug + ' body text.' + NL + NL + 'A second paragraph for ' + slug + '.';
async function seed(slug: string, type: string, frontmatter: Record<string, unknown>, source = 'default', text = body(slug)) {
  const result = await importFromContent(engine, slug, serializeMarkdown(frontmatter, text, '', { type: type as never, title: slug, tags: ['t1'] }),
    { noEmbed: true, forceRechunk: true, sourceId: source });
  expect(['imported', 'skipped']).toContain(result.status);
}

describe('repair private-labels', () => {
  let keepBefore: Record<string, Row> = {};
  let firstHash = '';
  let brainId = '';

  test('registered explicit-only and preview-bound', () => {
    const spec = repairSpec('private-labels');
    expect(spec.explicit_only).toBe(true);
    expect(spec.preview_bound).toBe(true);
    expect(spec.embeds).toBe('effect');
    expect(EXPLICIT_REPAIR_REGISTRY.map(s => s.kind)).toContain('private-labels');
    expect(PREVIEW_BOUND_REPAIR_REGISTRY.map(s => s.kind)).toContain('private-labels');
  });

  test('the preview counts every category over the scope, projects the window, lists the clear items and saves a hash', async () => {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [GIT_SOURCE]);
    for (const s of SEEDS) await seed(s.slug, s.type, s.frontmatter, s.source);
    // A git-canonical source refuses a direct import, so its page is seeded first (as the conversion would have found it).
    await engine.executeRaw('UPDATE sources SET config = $2::jsonb WHERE id = $1', [GIT_SOURCE, JSON.stringify({ canonical: 'git' })]);
    keepBefore = Object.fromEntries(await Promise.all(KEEP.map(async slug => [slug, await row(slug)] as const)));
    const preview = await json(['private-labels']);
    brainId = preview.scope.brain_id;
    expect(preview.mode).toBe('dry_run');
    expect(preview.details.counts.before).toEqual({ pinned_question: 1, derived: 1, strong_alias: 2, explicit_visibility: 1, alias: 2, 'alias-and-visibility': 1, 'git-publish': 1 });
    expect(preview.details.counts.after).toEqual(ALL_CLEARED);
    expect(preview.listing).toEqual([
      { item: 'default:notes/alias', class: 'alias', detail: 'remove access: private' },
      { item: 'default:notes/readers', class: 'alias', detail: 'remove access: private' },
      { item: 'default:notes/alias-vis', class: 'alias-and-visibility', detail: 'remove access: private, visibility: private' },
    ]);
    expect(preview.preview_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.apply_command).toContain('--apply --expect ' + preview.preview_hash);
    expect(preview.warnings.some((w: string) => w.includes('git-publish') && w.includes('1 page'))).toBe(true);
    expect(preview.warnings.some((w: string) => /widens what remote callers/.test(w))).toBe(true);
    expect(preview.details.ledger).toBe(ledgerPath(brainId));
    const again = await json(['private-labels']);
    expect(again.preview_hash).toBe(preview.preview_hash);
    firstHash = preview.preview_hash;
    const text = await run(['private-labels']);
    _resetCliExitVerdictForTests();
    expect(text).toContain('before:');
    expect(text).toContain('ledger:');
  });

  test('--class selects one class; an unknown class is refused', async () => {
    const git = await json(['private-labels', '--class', 'git-publish']);
    expect(git.listing).toEqual([{ item: GIT_SOURCE + ':notes/a', class: 'git-publish', detail: 'remove access: private' }]);
    const alias = await json(['private-labels', '--class', 'alias']);
    expect(alias.listing.map((l: { item: string }) => l.item)).toEqual(['default:notes/alias', 'default:notes/readers']);
    const bogus = await refusal(() => run(['private-labels', '--class', 'everything']));
    expect(bogus.code).toBe('invalid_params');
  });

  test('a caller that passes no undo ledger cannot apply or restore', async () => {
    const scope = await resolveRepairScope(engine);
    const logger = { info() {}, warn() {}, error() {} };
    const apply = await refusal(() => withEnv({ GBRAIN_HOME: dir }, async () => (await repairRunner(engine, { apply: true, logger })).run('private-labels', scope, { explicit: true, expect: firstHash })));
    expect(apply.code).toBe('invalid_params');
    const restore = await refusal(() => withEnv({ GBRAIN_HOME: dir }, async () => (await repairRunner(engine, { apply: false, logger })).run('private-labels', scope, { explicit: true, driftClass: 'restore' })));
    expect(restore.code).toBe('invalid_params');
  });

  test('a bare --apply refuses and changes nothing', async () => {
    const before = await row('notes/alias');
    const refused = await refusal(() => run(['private-labels', '--apply']));
    expect(refused.code).toBe('invalid_params');
    expect(await row('notes/alias')).toEqual(before);
  });

  test('--apply --expect clears exactly the approved alias pages, skips a page edited since the preview, and leaves keep and git pages alone', async () => {
    const preview = await json(['private-labels']);
    expect(preview.preview_hash).toBe(firstHash);
    const aliasBefore = await row('notes/alias');
    const visBefore = await row('notes/alias-vis');
    const gitBefore = await row('notes/a', GIT_SOURCE);
    await seed('notes/readers', 'note', { access: 'private', readable_by: ['alice-example'] }, 'default', body('notes/readers') + NL + NL + 'Edited after the preview.');
    const applied = await json(['private-labels', '--apply', '--expect', firstHash]);
    expect(applied.applied).toBe(2);
    expect(applied.skipped).toBe(1);
    expect(applied.failed).toEqual([]);

    const alias = await row('notes/alias');
    expect('access' in alias.frontmatter).toBe(false);
    expect(alias.frontmatter.status).toBe('draft');
    expect(alias.compiled_truth).toBe(aliasBefore.compiled_truth);
    const { access: _a, ...aliasRest } = aliasBefore.frontmatter;
    expect(alias.frontmatter).toEqual(aliasRest);

    const vis = await row('notes/alias-vis');
    expect('access' in vis.frontmatter).toBe(false);
    expect('visibility' in vis.frontmatter).toBe(false);
    const { access: _b, visibility: _c, ...visRest } = visBefore.frontmatter;
    expect(vis.frontmatter).toEqual(visRest);
    expect(vis.compiled_truth).toBe(visBefore.compiled_truth);

    expect((await row('notes/readers')).frontmatter.access).toBe('private');
    expect(await row('notes/a', GIT_SOURCE)).toEqual(gitBefore);
    for (const slug of KEEP) expect(await row(slug)).toEqual(keepBefore[slug]!);

    const ledger = ledgerPath(brainId);
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(ledger)).mode & 0o777).toBe(0o700);
    const lines = ledgerLines(brainId);
    expect(lines.map(l => [l.slug, l.removed])).toEqual([
      ['notes/alias', { access: 'private' }],
      ['notes/alias-vis', { access: 'Private', visibility: 'private' }],
    ]);
    expect(lines[0]).toMatchObject({ brain_id: brainId, source_id: 'default', page_id: aliasBefore.page_id, revision_before: aliasBefore.revision });
    expect(lines[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof lines[0].at).toBe('string');
  });

  test('a second preview lists the skipped page; once applied, the clear counts are 0 and readers are kept', async () => {
    const second = await json(['private-labels']);
    expect(second.listing).toEqual([{ item: 'default:notes/readers', class: 'alias', detail: 'remove access: private' }]);
    expect(second.details.counts.before.alias).toBe(1);
    expect(second.details.counts.before['alias-and-visibility']).toBe(0);
    const applied = await json(['private-labels', '--apply', '--expect', second.preview_hash]);
    expect(applied.applied).toBe(1);
    const readers = await row('notes/readers');
    expect('access' in readers.frontmatter).toBe(false);
    expect(readers.frontmatter.readable_by).toEqual(['alice-example']);
    const third = await json(['private-labels']);
    expect(third.listing ?? []).toEqual([]);
    expect(third.details.counts.before).toEqual(ALL_CLEARED);
    expect(third.details.counts.after).toEqual(ALL_CLEARED);
  });

  test('--class restore re-adds exactly the removed keys, and a second restore preview finds them restored', async () => {
    const slugs = ['notes/alias', 'notes/alias-vis', 'notes/readers'];
    const cleared = Object.fromEntries(await Promise.all(slugs.map(async slug => [slug, await row(slug)] as const)));
    const preview = await json(['private-labels', '--class', 'restore']);
    expect(preview.details.counts.before).toEqual({ restorable: 3, already_restored: 0, page_gone: 0 });
    expect(preview.details.counts.after).toEqual({ restorable: 0, already_restored: 3, page_gone: 0 });
    expect(preview.listing).toEqual([
      { item: 'default:notes/alias', class: 'restore', detail: 're-add access: private' },
      { item: 'default:notes/readers', class: 'restore', detail: 're-add access: private' },
      { item: 'default:notes/alias-vis', class: 'restore', detail: 're-add access: Private, visibility: private' },
    ]);
    const applied = await json(['private-labels', '--class', 'restore', '--apply', '--expect', preview.preview_hash]);
    expect(applied.applied).toBe(3);
    expect((await row('notes/alias')).frontmatter).toEqual({ ...cleared['notes/alias']!.frontmatter, access: 'private' });
    expect((await row('notes/alias-vis')).frontmatter).toEqual({ ...cleared['notes/alias-vis']!.frontmatter, access: 'Private', visibility: 'private' });
    expect((await row('notes/readers')).frontmatter).toEqual({ ...cleared['notes/readers']!.frontmatter, access: 'private' });
    for (const slug of slugs) expect((await row(slug)).compiled_truth).toBe(cleared[slug]!.compiled_truth);
    expect(ledgerLines(brainId).filter(l => l.restored).map(l => [l.slug, l.restored])).toEqual([
      ['notes/alias', { access: 'private' }], ['notes/readers', { access: 'private' }], ['notes/alias-vis', { access: 'Private', visibility: 'private' }],
    ]);
    const again = await json(['private-labels', '--class', 'restore']);
    expect(again.details.counts.before).toEqual({ restorable: 0, already_restored: 3, page_gone: 0 });
    const relisted = await json(['private-labels']);
    expect(relisted.details.counts.before.alias).toBe(2);
    expect(relisted.details.counts.before['alias-and-visibility']).toBe(1);
  });

  test('restore skips a page whose label was set again by hand since the preview, and keeps the value the user set', async () => {
    const clear = await json(['private-labels', '--class', 'alias']);
    expect((await json(['private-labels', '--class', 'alias', '--apply', '--expect', clear.preview_hash])).applied).toBe(2);
    const preview = await json(['private-labels', '--class', 'restore']);
    expect(preview.listing.map((l: { item: string }) => l.item)).toEqual(['default:notes/alias', 'default:notes/readers']);
    await seed('notes/alias', 'note', { status: 'draft', access: 'restricted' });
    const applied = await json(['private-labels', '--class', 'restore', '--apply', '--expect', preview.preview_hash]);
    expect(applied.applied).toBe(1);
    expect(applied.skipped).toBe(1);
    expect((await row('notes/alias')).frontmatter.access).toBe('restricted');
    expect((await row('notes/readers')).frontmatter.access).toBe('private');
    expect(ledgerLines(brainId).filter(l => l.restored && l.slug === 'notes/alias')).toHaveLength(1);
  });

  test('a restore recorded while its write was only accepted, whose write then failed, stays restorable', async () => {
    // The accepted-pending branch records the restored line before the queued write settles; here the write never landed.
    const page = await row('notes/readers');
    expect(page.frontmatter.access).toBe('private');
    const clear = await json(['private-labels', '--class', 'alias']);
    expect(clear.listing.map((l: { item: string }) => l.item)).toContain('default:notes/readers');
    const cleared = await json(['private-labels', '--class', 'alias', '--apply', '--expect', clear.preview_hash]);
    expect(cleared.failed).toEqual([]);
    const removal = ledgerLines(brainId).filter(l => l.slug === 'notes/readers' && l.removed).at(-1)!;
    appendFileSync(ledgerPath(brainId), JSON.stringify({ ...removal, removed: undefined, restored: removal.removed, at: new Date().toISOString(), request_id: crypto.randomUUID() }) + NL);
    expect('access' in (await row('notes/readers')).frontmatter).toBe(false);
    const preview = await json(['private-labels', '--class', 'restore']);
    expect(preview.listing.map((l: { item: string }) => l.item)).toContain('default:notes/readers');
    const restored = await json(['private-labels', '--class', 'restore', '--apply', '--expect', preview.preview_hash]);
    expect(restored.failed).toEqual([]);
    expect((await row('notes/readers')).frontmatter.access).toBe('private');
  });
});

/**
 * Clearing or restoring a label is a privacy edit, not a content write: a page stored above agent_written keeps its
 * tier, gets no trust_tier marker and files no lower_page proposal, on an unmanaged brain (the default keyless install)
 * and on a managed one.
 */
describe('repair private-labels keeps the trust tier', () => {
  async function curated(source: string, slug: string, frontmatter: Record<string, unknown>) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
    await seed(slug, 'note', frontmatter, source);
    await engine.transaction(tx => withCoordinatedWrite(tx, [source], () =>
      withTrustBackfill(tx, () => tx.executeRaw("UPDATE pages SET trust_tier='operator_curated' WHERE source_id=$1 AND slug=$2", [source, slug])), TEST_WRITE_ATTRIBUTION));
  }
  const state = async (source: string, slug: string) => {
    const [r] = await engine.executeRaw<{ tier: string; frontmatter: Record<string, unknown>; compiled_truth: string }>(
      'SELECT trust_tier::text AS tier, frontmatter, compiled_truth FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [source, slug]);
    return r!;
  };
  const proposals = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM trust_proposals'))[0]!.n);

  async function clearAndRestore(source: string) {
    const original = await state(source, 'notes/curated');
    expect(original.tier).toBe('operator_curated');
    const before = await proposals();
    const preview = await json(['private-labels', '--source', source]);
    expect(preview.listing).toEqual([{ item: source + ':notes/curated', class: 'alias-and-visibility', detail: 'remove access: private, visibility: private' }]);
    const applied = await json(['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash]);
    expect(applied.failed).toEqual([]);
    expect(applied.applied).toBe(1);
    const cleared = await state(source, 'notes/curated');
    const { access: _a, visibility: _v, ...rest } = original.frontmatter;
    expect(cleared.frontmatter).toEqual(rest);
    expect(cleared.tier).toBe('operator_curated');
    expect(cleared.compiled_truth).toBe(original.compiled_truth);
    expect(await proposals()).toBe(before);

    const restorePreview = await json(['private-labels', '--source', source, '--class', 'restore']);
    expect(restorePreview.details.counts.before.restorable).toBe(1);
    const restored = await json(['private-labels', '--source', source, '--class', 'restore', '--apply', '--expect', restorePreview.preview_hash]);
    expect(restored.applied).toBe(1);
    const back = await state(source, 'notes/curated');
    expect(back.frontmatter).toEqual(original.frontmatter);
    expect(back.tier).toBe('operator_curated');
    expect(await proposals()).toBe(before);
  }

  test('unmanaged brain', async () => {
    await curated('source-b', 'notes/curated', { access: 'private', visibility: 'private', owner_note: 'kept' });
    await clearAndRestore('source-b');
  });

  test('managed brain', async () => {
    await curated('source-c', 'notes/curated', { access: 'private', visibility: 'private', owner_note: 'kept' });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      await withEnv({ GBRAIN_HOME: dir }, () => clearAndRestore('source-c'));
      const published = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id='source-c' AND state='committed' AND intent->>'kind'='managed_maintenance_page' AND intent->>'keep_trust'='true'");
      expect(published[0]!.n).toBe(2);
    }
    finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  });
});

/**
 * git-publish is the one clear that writes Git history: on a managed brain with a git-canonical source the cleared page
 * is committed into the source checkout through the maintenance door, and the ledger records it so restore can re-add
 * the label.
 */
describe('repair private-labels --class git-publish on a git-canonical source', () => {
  test('apply removes the label, commits the page into the source checkout and records it; restore re-adds the label', async () => {
    const source = 'source-g';
    const root = join(dir, 'git-checkout');
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Example Writer'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'writer@example.invalid'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING', [source, root]);
    await seed('notes/nofile', 'note', { topic: 'shared' }, source);
    await engine.executeRaw('UPDATE sources SET config = $2::jsonb WHERE id = $1', [source, JSON.stringify({ canonical: 'git' })]);
    await engine.setConfig('sync.write_through', 'true');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      await withEnv({ GBRAIN_HOME: dir }, async () => {
        await registerLocalWriter(engine, 'cli');
        await claimWorktree(engine, source, root);
        const ctx = { engine, sourceId: source, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } } as OperationContext;
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/g', request_id: crypto.randomUUID(),
          content: serializeMarkdown({ access: 'private', topic: 'kept' }, body('notes/g'), '', { type: 'note' as never, title: 'notes/g', tags: ['t1'] }) } });
        expect(existsSync(join(root, 'notes', 'g.md'))).toBe(false);
        const missing = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/nofile', request_id: crypto.randomUUID(), expected_revision: (await row('notes/nofile', source)).revision,
          content: serializeMarkdown({ topic: 'edited' }, body('notes/nofile'), '', { type: 'note' as never, title: 'notes/nofile', tags: ['t1'] }) } }).then(() => null, (error: unknown) => error);
        expect(String((missing as Error | null)?.message)).toContain('The canonical file was removed outside coordinated publication.');
        const before = await row('notes/g', source);
        const preview = await json(['private-labels', '--source', source, '--class', 'git-publish']);
        expect(preview.listing).toEqual([{ item: source + ':notes/g', class: 'git-publish', detail: 'remove access: private' }]);
        const applied = await json(['private-labels', '--source', source, '--class', 'git-publish', '--apply', '--expect', preview.preview_hash]);
        expect(applied.failed).toEqual([]);
        expect(applied.applied).toBe(1);
        const cleared = await row('notes/g', source);
        const { access: _a, ...rest } = before.frontmatter;
        expect(cleared.frontmatter).toEqual(rest);
        expect(cleared.compiled_truth).toBe(before.compiled_truth);
        const file = join(root, 'notes', 'g.md');
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, 'utf8')).not.toMatch(/^access:/m);
        expect(execFileSync('git', ['log', '--format=%H', '--', 'notes/g.md'], { cwd: root, encoding: 'utf8' }).trim()).not.toBe('');
        const brain = preview.scope.brain_id;
        expect(ledgerLines(brain).filter(l => l.source_id === source).map(l => [l.slug, l.removed])).toEqual([['notes/g', { access: 'private' }]]);

        const restorePreview = await json(['private-labels', '--source', source, '--class', 'restore']);
        expect(restorePreview.listing).toEqual([{ item: source + ':notes/g', class: 'restore', detail: 're-add access: private' }]);
        const restored = await json(['private-labels', '--source', source, '--class', 'restore', '--apply', '--expect', restorePreview.preview_hash]);
        expect(restored.failed).toEqual([]);
        expect(restored.applied).toBe(1);
        expect((await row('notes/g', source)).frontmatter).toEqual(before.frontmatter);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  });
});

describe('repair private-labels when the undo ledger cannot record', () => {
  test('a clear whose ledger line fails to save still reports the page as applied and names the removed values; restore then says where to run', async () => {
    const source = 'source-h';
    const home = mkdtempSync(join(tmpdir(), 'gbrain-private-labels-ledger-'));
    mkdirSync(join(home, '.gbrain', 'repair'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'repair', 'private-labels'), 'a file where the ledger directory belongs');
    const runIn = async (argv: string[]) => {
      const out = JSON.parse(await withEnv({ GBRAIN_HOME: home, GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() => runRepairCommand(engine, [...argv, '--json'])))).results[0];
      _resetCliExitVerdictForTests();
      return out;
    };
    try {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
      await seed('notes/h', 'note', { access: 'private' }, source);
      const preview = await runIn(['private-labels', '--source', source]);
      const applied = await runIn(['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash]);
      expect(applied.failed).toEqual([]);
      expect(applied.applied).toBe(1);
      expect(JSON.stringify(applied)).toContain('access: private');
      expect('access' in (await row('notes/h', source)).frontmatter).toBe(false);
      const restore = await runIn(['private-labels', '--source', source, '--class', 'restore']);
      expect(restore.listing ?? []).toEqual([]);
      expect(restore.warnings.some((w: string) => w.includes('has no line for brain') && w.includes(restore.details.ledger))).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

test('a page with declared lineage keeps its label whatever its type, so its origin decides who reads it', () => {
  const lineage: Array<Record<string, unknown>> = [
    { access: 'private', derived_from: 'notes/origin' },
    { access: 'private', derived_from: ['notes/origin.md', 'notes/other'] },
    { access: 'private', visibility: 'private', derived_from: 'notes/origin' },
    { access: 'private', source_slug: 'notes/origin' },
  ];
  for (const frontmatter of lineage) expect(classifyPrivateLabel({ type: 'note', frontmatter, git: false })).toEqual({ keep: 'derived' });
  expect(classifyPrivateLabel({ type: 'note', frontmatter: { access: 'private' }, git: false })).toEqual({ clear: 'alias', removed: { access: 'private' } });
});
