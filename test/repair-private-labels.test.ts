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
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
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
import { privateLabelsLedger } from '../src/commands/repair-private-labels.ts';
import type { PrivateLabelsLedgerLine } from '../src/core/repair/private-labels.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';

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
    const lines = ledgerLines(brainId).filter(l => l.phase === 'committed');
    expect(lines.map(l => [l.slug, l.removed])).toEqual([
      ['notes/alias', { access: 'private' }],
      ['notes/alias-vis', { access: 'Private', visibility: 'private' }],
    ]);
    expect(lines[0]).toMatchObject({ brain_id: brainId, source_id: 'default', page_id: aliasBefore.page_id, revision_before: aliasBefore.revision });
    expect(lines[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof lines[0].at).toBe('string');
    // GST-2092: each committed line follows its write-ahead intent line (same request) and names the revision it wrote.
    const intents = ledgerLines(brainId).filter(l => l.phase === 'intent');
    expect(intents.map(l => [l.slug, l.removed, l.request_id])).toEqual(lines.map(l => [l.slug, l.removed, l.request_id]));
    expect(lines[0].revision_after).toBe(alias.revision);
    expect(lines[1].revision_after).toBe(vis.revision);
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
    expect(preview.details.counts.before).toEqual({ restorable: 3, already_restored: 0, page_gone: 0, removed_after_restore: 0 });
    expect(preview.details.counts.after).toEqual({ restorable: 0, already_restored: 3, page_gone: 0, removed_after_restore: 0 });
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
    expect(ledgerLines(brainId).filter(l => l.restored && l.phase === 'committed').map(l => [l.slug, l.restored])).toEqual([
      ['notes/alias', { access: 'private' }], ['notes/readers', { access: 'private' }], ['notes/alias-vis', { access: 'Private', visibility: 'private' }],
    ]);
    const again = await json(['private-labels', '--class', 'restore']);
    expect(again.details.counts.before).toEqual({ restorable: 0, already_restored: 3, page_gone: 0, removed_after_restore: 0 });
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
    expect(ledgerLines(brainId).filter(l => l.restored && l.slug === 'notes/alias' && l.phase === 'committed')).toHaveLength(1);
    expect(ledgerLines(brainId).filter(l => l.restored && l.slug === 'notes/alias' && l.phase === 'intent')).toHaveLength(1);
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
        expect(ledgerLines(brain).filter(l => l.source_id === source && l.phase === 'committed').map(l => [l.slug, l.removed])).toEqual([['notes/g', { access: 'private' }]]);

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
  test('the intent line is written before the page: a ledger that cannot record refuses the clear and leaves the label; the same --expect resumes once it can (GST-2092, GST-2128 item 7)', async () => {
    const source = 'source-h';
    const home = mkdtempSync(join(tmpdir(), 'gbrain-private-labels-ledger-'));
    mkdirSync(join(home, '.gbrain', 'repair'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'repair', 'private-labels'), 'a file where the ledger directory belongs');
    const inHome = (argv: string[]) => withEnv({ GBRAIN_HOME: home, GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() => runRepairCommand(engine, [...argv, '--json'])));
    const runIn = async (argv: string[]) => { const out = JSON.parse(await inHome(argv)).results[0]; _resetCliExitVerdictForTests(); return out; };
    try {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
      await seed('notes/h', 'note', { access: 'private' }, source);
      const preview = await runIn(['private-labels', '--source', source]);
      const refused = await refusal(() => inHome(['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash]));
      _resetCliExitVerdictForTests();
      expect(refused.code).toBe('storage_error');
      expect(refused.message).toContain('ledger');
      expect((await row('notes/h', source)).frontmatter.access).toBe('private');
      rmSync(join(home, '.gbrain', 'repair', 'private-labels'));
      const applied = await runIn(['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash]);
      expect(applied.failed).toEqual([]);
      expect(applied.applied).toBe(1);
      expect('access' in (await row('notes/h', source)).frontmatter).toBe(false);
      const restore = await runIn(['private-labels', '--source', source, '--class', 'restore']);
      expect(restore.listing).toEqual([{ item: source + ':notes/h', class: 'restore', detail: 're-add access: private' }]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('restore in a home whose ledger has no line for the brain says where to run it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-private-labels-empty-'));
    try {
      const out = JSON.parse(await withEnv({ GBRAIN_HOME: home, GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() => runRepairCommand(engine, ['private-labels', '--source', 'source-h', '--class', 'restore', '--json'])))).results[0];
      _resetCliExitVerdictForTests();
      expect(out.listing ?? []).toEqual([]);
      expect(out.warnings.some((w: string) => w.includes('has no line for brain') && w.includes(out.details.ledger))).toBe(true);
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

/**
 * GST-2092: the undo ledger is write-ahead. A crash between the page write and the line that confirms it (forced here:
 * the commit append throws, as a process that died there would leave the file) still leaves the intent line, so
 * --class restore finds the page and puts the label back.
 */
describe('repair private-labels write-ahead ledger', () => {
  test('a crash after the page write and before its commit line leaves the intent line, and restore puts the label back', async () => {
    const source = 'source-w';
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
    await seed('notes/w', 'note', { access: 'private', topic: 'kept' }, source);
    const before = await row('notes/w', source);
    const preview = await json(['private-labels', '--source', source]);
    expect(preview.listing).toEqual([{ item: source + ':notes/w', class: 'alias', detail: 'remove access: private' }]);
    const brain = preview.scope.brain_id;
    const scope = await resolveRepairScope(engine, source);
    const logger = { info() {}, warn() {}, error() {} };
    const applied = await withEnv({ GBRAIN_HOME: dir }, async () => {
      const real = privateLabelsLedger(brain);
      const crashing = { ...real, record(line: PrivateLabelsLedgerLine) {
        if (line.phase !== 'intent') throw new Error('forced crash after the page write');
        real.record(line);
      } };
      return (await repairRunner(engine, { apply: true, logger })).run('private-labels', scope, { explicit: true, expect: preview.preview_hash, privateLabelsLedger: crashing });
    });
    expect(applied.failed).toEqual([]);
    expect('access' in (await row('notes/w', source)).frontmatter).toBe(false);
    const lines = ledgerLines(brain).filter(l => l.source_id === source);
    expect(lines.map(l => [l.slug, l.phase, l.removed])).toEqual([['notes/w', 'intent', { access: 'private' }]]);
    const restorePreview = await json(['private-labels', '--source', source, '--class', 'restore']);
    expect(restorePreview.listing).toEqual([{ item: source + ':notes/w', class: 'restore', detail: 're-add access: private' }]);
    const restored = await json(['private-labels', '--source', source, '--class', 'restore', '--apply', '--expect', restorePreview.preview_hash]);
    expect(restored.applied).toBe(1);
    expect((await row('notes/w', source)).frontmatter).toEqual(before.frontmatter);
    expect(ledgerLines(brain).filter(l => l.source_id === source).map(l => [l.phase, l.restored ?? null])).toEqual([
      ['intent', null], ['intent', { access: 'private' }], ['committed', { access: 'private' }],
    ]);
  });
});

/**
 * Review finding on GST-2092: a crash can leave the ledger's last line cut off. The next intent line must start on a
 * line of its own, or it joins the torn tail, is unreadable, and restore cannot find the page it cleared.
 */
describe('repair private-labels ledger with a torn last line', () => {
  test('the intent line after a torn tail stays readable, so a crash after the page write still restores', async () => {
    const source = 'source-t';
    const home = mkdtempSync(join(tmpdir(), 'gbrain-private-labels-torn-'));
    const runIn = async (argv: string[]) => {
      const out = JSON.parse(await withEnv({ GBRAIN_HOME: home, GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() => runRepairCommand(engine, [...argv, '--json'])))).results[0];
      _resetCliExitVerdictForTests();
      return out;
    };
    try {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
      await seed('notes/t', 'note', { access: 'private' }, source);
      const preview = await runIn(['private-labels', '--source', source]);
      const brain = preview.scope.brain_id;
      const path = join(home, '.gbrain', 'repair', 'private-labels', brain + '.jsonl');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"');
      const scope = await resolveRepairScope(engine, source);
      const logger = { info() {}, warn() {}, error() {} };
      const applied = await withEnv({ GBRAIN_HOME: home }, async () => {
        const real = privateLabelsLedger(brain);
        const crashing = { ...real, record(line: PrivateLabelsLedgerLine) {
          if (line.phase !== 'intent') throw new Error('forced crash after the page write');
          real.record(line);
        } };
        return (await repairRunner(engine, { apply: true, logger })).run('private-labels', scope, { explicit: true, expect: preview.preview_hash, privateLabelsLedger: crashing });
      });
      expect(applied.failed).toEqual([]);
      expect('access' in (await row('notes/t', source)).frontmatter).toBe(false);
      const restore = await runIn(['private-labels', '--source', source, '--class', 'restore']);
      expect(restore.listing).toEqual([{ item: source + ':notes/t', class: 'restore', detail: 're-add access: private' }]);
      expect(restore.warnings.some((w: string) => w.startsWith('1 ledger line(s) could not be read'))).toBe(true);
      expect((await runIn(['private-labels', '--source', source, '--class', 'restore', '--apply', '--expect', restore.preview_hash])).applied).toBe(1);
      expect((await row('notes/t', source)).frontmatter.access).toBe('private');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

/**
 * GST-2128 item 4: restore reads ledger lines as untrusted input. Only access and visibility (visibility only as
 * private) with string values are re-added; any other line, and one whose page id is not an integer, is counted
 * unreadable instead of failing the preview or reaching a page.
 */
describe('repair private-labels restore reads only well-formed ledger lines', () => {
  test('a line with another key, a non-string value, a widening visibility or a non-integer page id is unreadable, and the rest restores', async () => {
    const source = 'source-r';
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
    await seed('notes/r1', 'note', { access: 'private' }, source);
    await seed('notes/r2', 'note', { topic: 'plain' }, source);
    const clear = await json(['private-labels', '--source', source]);
    expect((await json(['private-labels', '--source', source, '--apply', '--expect', clear.preview_hash])).applied).toBe(1);
    const brain = clear.scope.brain_id;
    const r2 = await row('notes/r2', source);
    const base = { at: new Date().toISOString(), brain_id: brain, source_id: source, slug: 'notes/r2', page_id: r2.page_id, revision_before: r2.revision, request_id: crypto.randomUUID() };
    for (const line of [
      { ...base, removed: { access: 'private', owner: 'mallory-example' } },
      { ...base, removed: { access: 7 } },
      { ...base, removed: { visibility: 'world' } },
      { ...base, page_id: 'not-a-page', removed: { access: 'private' } },
    ]) appendFileSync(ledgerPath(brain), JSON.stringify(line) + NL);
    const preview = await json(['private-labels', '--source', source, '--class', 'restore']);
    expect(preview.listing).toEqual([{ item: source + ':notes/r1', class: 'restore', detail: 're-add access: private' }]);
    expect(preview.details.counts.before.restorable).toBe(1);
    expect(preview.warnings.some((w: string) => w.startsWith('4 ledger line(s) could not be read'))).toBe(true);
    const restored = await json(['private-labels', '--source', source, '--class', 'restore', '--apply', '--expect', preview.preview_hash]);
    expect(restored.applied).toBe(1);
    expect((await row('notes/r1', source)).frontmatter.access).toBe('private');
    expect((await row('notes/r2', source)).frontmatter).toEqual(r2.frontmatter);
  });
});

/**
 * GST-2128 item 9: a restore whose write landed is recorded with the revision it wrote. A page whose label was removed
 * by hand after that is not listed again: the preview counts it as removed_after_restore and says so.
 */
describe('repair private-labels restore after a landed restore', () => {
  test('a label removed by hand after a landed restore is counted and not listed', async () => {
    const source = 'source-m';
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
    await seed('notes/m', 'note', { access: 'private' }, source);
    const clear = await json(['private-labels', '--source', source]);
    expect((await json(['private-labels', '--source', source, '--apply', '--expect', clear.preview_hash])).applied).toBe(1);
    const restore = await json(['private-labels', '--source', source, '--class', 'restore']);
    expect((await json(['private-labels', '--source', source, '--class', 'restore', '--apply', '--expect', restore.preview_hash])).applied).toBe(1);
    expect((await row('notes/m', source)).frontmatter.access).toBe('private');
    await seed('notes/m', 'note', { topic: 'edited by hand' }, source);
    const again = await json(['private-labels', '--source', source, '--class', 'restore']);
    expect(again.listing ?? []).toEqual([]);
    expect(again.details.counts.before).toEqual({ restorable: 0, already_restored: 0, page_gone: 0, removed_after_restore: 1 });
    expect(again.warnings.some((w: string) => w.includes('removed after a restore landed'))).toBe(true);
  });
});

/**
 * GST-2093: clearing an ordinary origin's label also lifts pages whose only privacy came from it: a derived_from page
 * (when the origin's visibility: private goes) and a life-chronicle event (which honors the origin's alias). The
 * preview counts them per window, by category, and warns; a remote non-owner read confirms each count.
 */
describe('repair private-labels preview counts the dependents a window exposes', () => {
  const source = 'source-d';
  const remoteGet = async (slug: string) => (await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'stdio', sourceId: source, takesHoldersAllowList: ['world'] }))
    .content.map(c => c.text).join(NL);

  test('derived_from pages and chronicle events of the window are counted, the warning names the counts, and the reads agree', async () => {
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
    await seed('meetings/m1', 'note', { access: 'private' }, source);
    await seed('notes/origin-d', 'note', { access: 'private', visibility: 'private' }, source);
    await seed('notes/other-private', 'note', { visibility: 'private' }, source);
    await seed('notes/summary-d', 'note', { derived_from: 'notes/origin-d.md' }, source, 'canarysummaryd lineage page.');
    await seed('notes/summary-two', 'note', { derived_from: ['notes/origin-d', 'notes/other-private'] }, source, 'canarysummarytwo lineage page.');
    await seed('events/e1', 'event', { captured_via: 'life-chronicle:test', event: { depth: 'meetings/m1' } }, source, 'canaryeventone chronicle event.');
    for (const slug of ['notes/summary-d', 'notes/summary-two', 'events/e1']) expect(await remoteGet(slug)).not.toContain('canary');

    const first = await json(['private-labels', '--source', source, '--limit', '1']);
    expect(first.listing).toEqual([{ item: source + ':meetings/m1', class: 'alias', detail: 'remove access: private' }]);
    expect(first.details.dependents).toEqual({ derived_from: 0, atom: 0, concept: 0, life_chronicle: 1 });
    const whole = await json(['private-labels', '--source', source]);
    expect(whole.listing.map((l: { item: string }) => l.item)).toEqual([source + ':meetings/m1', source + ':notes/origin-d']);
    expect(whole.details.dependents).toEqual({ derived_from: 1, atom: 0, concept: 0, life_chronicle: 1 });
    const warning = whole.warnings.find((w: string) => w.includes('page(s) whose only privacy'));
    expect(warning).toContain('2 page(s)');
    expect(warning).toContain('1 derived_from');
    expect(warning).toContain('1 life-chronicle');
    expect(warning).not.toContain('summary');

    const applied = await json(['private-labels', '--source', source, '--apply', '--expect', whole.preview_hash]);
    expect(applied.applied).toBe(2);
    __resetPrivateVisibilityCacheForTests();
    expect(await remoteGet('notes/summary-d')).toContain('canarysummaryd');
    expect(await remoteGet('events/e1')).toContain('canaryeventone');
    expect(await remoteGet('notes/summary-two')).not.toContain('canary');
    const none = await json(['private-labels', '--source', source]);
    expect(none.details.dependents).toEqual({ derived_from: 0, atom: 0, concept: 0, life_chronicle: 0 });
    expect(none.warnings.some((w: string) => w.includes('page(s) whose only privacy'))).toBe(false);
  });
});

/**
 * Review findings on GST-2093: the dependents count follows the remote privacy rules on every page type (an ordinary
 * concept or note with derived_from, an atom whose origin is the cleared page, a synthesized concept built from such an
 * atom), and the preview hash binds the pages it exposes, so a dependent added after the preview refuses the apply.
 */
describe('repair private-labels dependents follow the remote privacy rules and bind the preview', () => {
  const remoteGetIn = async (source: string, slug: string) => (await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'stdio', sourceId: source, takesHoldersAllowList: ['world'] }))
    .content.map(c => c.text).join(NL);

  test('every page type whose only privacy is the cleared origin is counted, and each becomes readable remotely', async () => {
    const source = 'source-x';
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
    await seed('notes/origin-x', 'note', { access: 'private', visibility: 'private' }, source);
    await seed('concepts/plain-x', 'concept', { derived_from: 'notes/origin-x' }, source, 'canaryplainconcept lineage page.');
    await seed('notes/note-x', 'note', { derived_from: 'notes/origin-x' }, source, 'canarynotex lineage page.');
    await seed('atoms/a1-x', 'atom', { visibility: 'world', source_slug: 'notes/origin-x' }, source, 'canaryatomone extracted atom.');
    await seed('atoms/a2-x', 'atom', { visibility: 'world', source_slug: 'notes/origin-x' }, source, 'canaryatomtwo extracted atom.');
    await seed('concepts/synth-x', 'concept', { synthesized_by: 'test', visibility: 'world' }, source, 'canarysynthx synthesized concept.');
    await engine.executeRaw("INSERT INTO links (from_page_id, to_page_id, link_type, link_source) SELECT c.id, a.id, 'synthesized_from', 'concept-provenance' FROM pages c, pages a "
      + "WHERE c.source_id = $1 AND a.source_id = $1 AND c.slug = 'concepts/synth-x' AND a.slug = 'atoms/a2-x'", [source]);
    const dependents = ['concepts/plain-x', 'notes/note-x', 'atoms/a1-x', 'atoms/a2-x', 'concepts/synth-x'];
    for (const slug of dependents) expect(await remoteGetIn(source, slug)).not.toContain('canary');

    const preview = await json(['private-labels', '--source', source]);
    expect(preview.listing).toEqual([{ item: source + ':notes/origin-x', class: 'alias-and-visibility', detail: 'remove access: private, visibility: private' }]);
    expect(preview.details.dependents).toEqual({ derived_from: 2, atom: 2, concept: 1, life_chronicle: 0 });
    expect(preview.warnings.find((w: string) => w.includes('page(s) whose only privacy'))).toContain('5 page(s)');

    expect((await json(['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash])).applied).toBe(1);
    __resetPrivateVisibilityCacheForTests();
    for (const slug of dependents) expect(await remoteGetIn(source, slug)).toContain('canary');
  });

  test('a chronicle event whose origin is private only through derived_from on the cleared page is counted', async () => {
    const source = 'source-z';
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
    await seed('notes/origin-z', 'note', { access: 'private', visibility: 'private' }, source);
    await seed('notes/summary-z', 'note', { derived_from: 'notes/origin-z' }, source, 'canarysummaryz lineage page.');
    await seed('events/e-z', 'event', { captured_via: 'life-chronicle:test', event: { depth: 'notes/summary-z' } }, source, 'canaryeventz chronicle event.');
    for (const slug of ['notes/summary-z', 'events/e-z']) expect(await remoteGetIn(source, slug)).not.toContain('canary');
    const preview = await json(['private-labels', '--source', source]);
    expect(preview.details.dependents).toEqual({ derived_from: 1, atom: 0, concept: 0, life_chronicle: 1 });
    expect((await json(['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash])).applied).toBe(1);
    __resetPrivateVisibilityCacheForTests();
    for (const slug of ['notes/summary-z', 'events/e-z']) expect(await remoteGetIn(source, slug)).toContain('canary');
  });

  test('a dependent added after the preview refuses the old --expect; a fresh preview counts it and applies', async () => {
    const source = 'source-y';
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
    await seed('notes/origin-y', 'note', { access: 'private', visibility: 'private' }, source);
    const preview = await json(['private-labels', '--source', source]);
    expect(preview.details.dependents).toEqual({ derived_from: 0, atom: 0, concept: 0, life_chronicle: 0 });
    await seed('notes/summary-y', 'note', { derived_from: 'notes/origin-y' }, source, 'canarysummaryy lineage page.');
    const refused = await refusal(() => run(['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash, '--json']));
    _resetCliExitVerdictForTests();
    expect(refused.code).toBe('preview_changed');
    expect((await row('notes/origin-y', source)).frontmatter.access).toBe('private');
    const fresh = await json(['private-labels', '--source', source]);
    expect(fresh.details.dependents).toEqual({ derived_from: 1, atom: 0, concept: 0, life_chronicle: 0 });
    expect(fresh.preview_hash).not.toBe(preview.preview_hash);
    expect((await json(['private-labels', '--source', source, '--apply', '--expect', fresh.preview_hash])).applied).toBe(1);
  });
});

/**
 * GST-2128 item 1: on a brain without managed persistence the repair writes only the database, so a page whose file sits
 * in its source's checkout would get the label back from the file at the next sync or re-import while the ledger says
 * it was cleared. Such a page is held (outcome file_backed) with the manual fix; a page with no file still clears.
 */
describe('repair private-labels on an unmanaged file-backed source', () => {
  test('a page with a file in the checkout is held and keeps its label through a re-import; a database-only page clears', async () => {
    const source = 'source-f';
    const root = join(dir, 'checkout-f');
    mkdirSync(join(root, 'notes'), { recursive: true });
    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING', [source, root]);
    const file = join(root, 'notes', 'f.md');
    writeFileSync(file, serializeMarkdown({ access: 'private' }, body('notes/f'), '', { type: 'note' as never, title: 'notes/f', tags: ['t1'] }));
    expect((await importFromFile(engine, file, 'notes/f.md', { sourceId: source, noEmbed: true })).status).toBe('imported');
    await seed('notes/dbonly', 'note', { access: 'private' }, source);
    const preview = await json(['private-labels', '--source', source]);
    expect(preview.listing.map((l: { item: string }) => l.item)).toEqual([source + ':notes/f', source + ':notes/dbonly']);
    expect(preview.warnings.some((w: string) => w.includes('1 listed page(s) have a file'))).toBe(true);
    const applied = await json(['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash]);
    expect(applied.failed).toEqual([]);
    expect(applied.applied).toBe(1);
    expect(applied.outcomes.file_backed).toBe(1);
    expect(applied.outcome_items.find((o: { item: string }) => o.item === source + ':notes/f').reason).toContain('notes/f.md');
    expect((await row('notes/f', source)).frontmatter.access).toBe('private');
    expect('access' in (await row('notes/dbonly', source)).frontmatter).toBe(false);
    const brain = preview.scope.brain_id;
    expect(ledgerLines(brain).filter(l => l.source_id === source && l.removed).map(l => l.slug)).not.toContain('notes/f');
    await importFromFile(engine, file, 'notes/f.md', { sourceId: source, noEmbed: true, forceRechunk: true });
    expect((await row('notes/f', source)).frontmatter.access).toBe('private');
    const restore = await json(['private-labels', '--source', source, '--class', 'restore']);
    expect(restore.listing).toEqual([{ item: source + ':notes/dbonly', class: 'restore', detail: 're-add access: private' }]);
  });
});

/**
 * GST-2128 item 7: an apply whose last item fails keeps the approved set, so the same --expect resumes once the cause is gone.
 */
describe('repair private-labels resumes the same --expect after the last item failed', () => {
  test('a forced failure on the last item, then the same apply command applies it', async () => {
    const source = 'source-k';
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
    await seed('notes/k1', 'note', { access: 'private' }, source);
    await seed('notes/k2', 'note', { access: 'private' }, source);
    const preview = await json(['private-labels', '--source', source]);
    expect(preview.listing.map((l: { item: string }) => l.item)).toEqual([source + ':notes/k1', source + ':notes/k2']);
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION test_refuse_k2() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source_id = 'source-k' AND NEW.slug = 'notes/k2' THEN RAISE EXCEPTION 'forced failure for notes/k2'; END IF; RETURN NEW; END $$`);
    await engine.executeRaw('CREATE TRIGGER test_refuse_k2 BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION test_refuse_k2()');
    let failed: unknown = null;
    try {
      failed = await run(['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash, '--json'])
        .then(out => JSON.parse(out).results[0].failed.length ? 'item failed' : null, (error: unknown) => error);
    } finally {
      _resetCliExitVerdictForTests();
      await engine.executeRaw('DROP TRIGGER test_refuse_k2 ON pages');
      await engine.executeRaw('DROP FUNCTION test_refuse_k2()');
    }
    expect(failed).not.toBeNull();
    expect((await row('notes/k2', source)).frontmatter.access).toBe('private');
    const retried = await json(['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash]);
    expect(retried.failed).toEqual([]);
    expect('access' in (await row('notes/k1', source)).frontmatter).toBe(false);
    expect('access' in (await row('notes/k2', source)).frontmatter).toBe(false);
  });
});
