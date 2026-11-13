/**
 * GST-2603: a label repair refused pages whose file differs from the database row only in frontmatter gbrain derived itself.
 *
 * 1. Protects: gbrain repair visibility --slug (and repair private-labels, through the same label-only write) labels a page
 *    whose stored row carries a stamp its file never had: a schema-pack retype (type plus its legacy_type record, the file
 *    still naming the old type), the pre-#6454 stored type copy of a renamed gbrain-base type, the grandfather validate:false
 *    stamp, or a legacy_type record whose file already names the page's type. The file changes only on its label line. A page
 *    whose file differs in a real key (a date, the tags) is held in the preview with that key named, never a stamp, and stays
 *    out of the preview hash and the approved set; at apply a page whose file changed since the preview declines alone
 *    (source_changed, or label_edit_refused when its label line can no longer be edited as a line), counts in declined,
 *    never trips item_failures_systemic, and the run exits 0. A repo-less brain and an unmanaged checkout label the same way.
 *    An exact-page access rule (gbrain access rule add --slug) is a readers list, not the private label: a named reader reads
 *    it, while the label repair's private page stays hidden from that reader.
 * 2. Fails when: a stamp-only page refuses or trips the breaker, a held page is listed, approved, hashed or names a stamp, a
 *    declined page stops the run or exits 1, or a page rule is offered as the same label class.
 * 3. Real seams: the managed-brain harness (claimed Git worktree, managed sync, the maintenance door, the Git effect),
 *    remote:false, the gbrain repair and gbrain access rule command entries, MCP dispatch with minted tokens; a repo-less brain
 *    and a brain without managed persistence whose source has a checkout. PGLite, and Postgres with DATABASE_URL.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { addMember } from '../src/core/access/members.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const NL = String.fromCharCode(10);
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const note = (title: string, lines: string[], body: string) => ['---', 'title: ' + title, ...lines, '---', '', body, ''].join(NL);
/** The file a label repair publishes: the same bytes with \`visibility: private\` as the frontmatter's last line. */
const withVisibility = (text: string) => text.replace(NL + '---' + NL + NL, NL + 'visibility: private' + NL + '---' + NL + NL);

/** Each page's file and the database-only edit an older gbrain made to its row. */
const PAGES: Record<string, { file: string; stamp: string }> = {
  // A schema-pack retype: the column took the new type and legacy_type records the old one; the file still names the old type.
  'notes/retyped-example': { file: note('Retyped', ['type: note'], 'Retyped body.'), stamp: "type='media', frontmatter=frontmatter || '{\"legacy_type\":\"note\"}'::jsonb" },
  // Pre-#6454: the stored frontmatter kept a type copy, the gbrain-base 1.0.0 name for the path; a later pack retyped the column.
  'writing/essay-example': { file: ['---', 'type: writing', 'title: Essay', '---', '', 'An essay body.', ''].join(NL), stamp: "type='media', frontmatter=frontmatter || '{\"type\":\"writing\"}'::jsonb" },
  // The v0.13.1 grandfather stamped validate:false into the database only.
  'notes/grand-example': { file: note('Grand', [], 'Grand body.'), stamp: "frontmatter=frontmatter || '{\"validate\":false}'::jsonb" },
  // A retype record whose file already names the page's type.
  'notes/legacy-example': { file: note('Legacy', ['type: media'], 'Legacy body.'), stamp: "frontmatter=frontmatter || '{\"legacy_type\":\"note\"}'::jsonb" },
  // Real differences: a date and a tag the file does not hold.
  'notes/dated-example': { file: note('Dated', ['date: 2024-01-02'], 'Dated body.'), stamp: "frontmatter=frontmatter || '{\"date\":\"2023-05-06\",\"validate\":false}'::jsonb" },
  'notes/tagged-example': { file: note('Tagged', ['tags:', '  - alpha'], 'Tagged body.'), stamp: '' },
  // Stamps and a real key at once.
  'notes/mixed-example': { file: note('Mixed', ['type: note', 'date: 2024-01-02'], 'Mixed body.'), stamp: "type='media', frontmatter=frontmatter || '{\"legacy_type\":\"note\",\"validate\":false,\"date\":\"2023-05-06\"}'::jsonb" },
};
/** A page whose frontmatter holds only what a file with no frontmatter imports as (its title from the slug), stamped validate:false. */
const bare = (slug: string) => 'Body of ' + slug.split('/').pop() + '.' + NL;
const framed = (slug: string) => note(parseMarkdown(bare(slug), slug).title, [], bare(slug).trimEnd());

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log;
  console.log = (...parts: unknown[]) => { printed += parts.map(String).join(' ') + NL; };
  try { await fn(); } finally { console.log = original; }
  return printed;
}
/** One repair run through the command entry: its first result and the CLI exit verdict. */
const run = async (engine: BrainEngine, argv: string[]) => {
  _resetCliExitVerdictForTests();
  const out = await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() => runRepairCommand(engine, [...argv, '--json'])));
  const exit = currentExitCode();
  _resetCliExitVerdictForTests();
  return { result: JSON.parse(out).results[0], exit };
};
const repair = async (engine: BrainEngine, argv: string[]) => (await run(engine, argv)).result;
const previewApply = async (engine: BrainEngine, argv: string[]) => {
  const preview = await repair(engine, argv);
  expect(preview.preview_hash).toBeString();
  const applied = await run(engine, [...argv, '--apply', '--expect', preview.preview_hash]);
  return { preview, applied: applied.result, exit: applied.exit };
};
const slugArgs = (slugs: string[]) => ['visibility', ...slugs.flatMap(slug => ['--slug', slug])];
const row = async (engine: BrainEngine, slug: string, sourceId = 'default') => (await engine.executeRaw<{ type: string; frontmatter: Record<string, unknown> }>(
  'SELECT type, frontmatter FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]!;
const stampRow = (engine: BrainEngine, sourceId: string, slug: string, set: string) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => withTrustBackfill(tx, () =>
  tx.executeRaw('UPDATE pages SET ' + set + ', knowledge_revision=gen_random_uuid() WHERE source_id=$1 AND slug=$2', [sourceId, slug])), TEST_WRITE_ATTRIBUTION));

for (const backend of testBackends()) describe('[' + backend + '] label repairs over gbrain\'s own derived stamps on a managed git source', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), 'archive/' + NL); durableGitRepo(root, ['.gitignore']); };
  const onDisk = (root: string, slug: string) => readFileSync(join(root, slug + '.md'), 'utf8');
  /** Commits the pages' files, syncs them, then makes each stored row's database-only edit as an older gbrain did. */
  async function seed(engine: BrainEngine, root: string, files: Record<string, string>, stamps: Record<string, string> = {}) {
    for (const [slug, text] of Object.entries(files)) { mkdirSync(join(root, slug, '..'), { recursive: true }); writeFileSync(join(root, slug + '.md'), text); }
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
    await performManagedSync(engine, OPTS);
    await settleManagedGitEffects(engine);
    for (const [slug, set] of Object.entries(stamps)) {
      if (slug === 'notes/tagged-example') await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        "INSERT INTO tags (page_id, tag) SELECT id, 'beta' FROM pages WHERE source_id='default' AND slug=$1", [slug]), TEST_WRITE_ATTRIBUTION));
      else if (set) await stampRow(engine, 'default', slug, set);
    }
  }
  const seedPages = (engine: BrainEngine, root: string, slugs: string[]) => seed(engine, root, Object.fromEntries(slugs.map(slug => [slug, PAGES[slug]!.file])),
    Object.fromEntries(slugs.map(slug => [slug, slug === 'notes/tagged-example' ? 'tag' : PAGES[slug]!.stamp])));
  const listedItems = (preview: { listing?: Array<{ item: string }> }) => (preview.listing ?? []).map(entry => entry.item).sort();

  test('only the type stamp differs (a schema-pack retype, a renamed gbrain-base type): the pages are labelled and their files gain only the visibility line', () => managedBrain(async ({ engine, root }) => {
    const slugs = ['notes/retyped-example', 'writing/essay-example'];
    await seedPages(engine, root, slugs);
    const before = Object.fromEntries(slugs.map(slug => [slug, onDisk(root, slug)]));
    const { preview, applied, exit } = await previewApply(engine, slugArgs(slugs));
    expect(listedItems(preview)).toEqual(slugs.map(slug => 'default:' + slug).sort());
    expect(preview.details?.held).toBeUndefined();
    expect({ applied: applied.applied, failed: applied.failed, stopped: applied.stopped, exit }).toEqual({ applied: 2, failed: [], stopped: undefined, exit: 0 });
    await settleManagedGitEffects(engine);
    for (const slug of slugs) {
      expect(onDisk(root, slug)).toBe(withVisibility(before[slug]!));
      expect(await row(engine, slug)).toMatchObject({ type: 'media', frontmatter: expect.objectContaining({ visibility: 'private' }) });
    }
    expect((await row(engine, 'notes/retyped-example')).frontmatter.legacy_type).toBe('note');
  }, { databaseUrl, setup }), 240_000);

  test('only the grandfather stamp differs: the page is labelled, keeps the stamp, and its file gains only the visibility line', () => managedBrain(async ({ engine, root }) => {
    const slug = 'notes/grand-example';
    await seedPages(engine, root, [slug]);
    const before = onDisk(root, slug);
    const { applied, exit } = await previewApply(engine, slugArgs([slug]));
    expect({ applied: applied.applied, failed: applied.failed, exit }).toEqual({ applied: 1, failed: [], exit: 0 });
    await settleManagedGitEffects(engine);
    expect(onDisk(root, slug)).toBe(withVisibility(before));
    expect((await row(engine, slug)).frontmatter).toMatchObject({ visibility: 'private', validate: false });
  }, { databaseUrl, setup }), 240_000);

  test('only legacy_type differs (the file already names the page\'s type): the page is labelled and keeps its retype record', () => managedBrain(async ({ engine, root }) => {
    const slug = 'notes/legacy-example';
    await seedPages(engine, root, [slug]);
    const before = onDisk(root, slug);
    const { applied, exit } = await previewApply(engine, slugArgs([slug]));
    expect({ applied: applied.applied, failed: applied.failed, exit }).toEqual({ applied: 1, failed: [], exit: 0 });
    await settleManagedGitEffects(engine);
    expect(onDisk(root, slug)).toBe(withVisibility(before));
    expect((await row(engine, slug)).frontmatter).toMatchObject({ visibility: 'private', legacy_type: 'note' });
  }, { databaseUrl, setup }), 240_000);

  test('a real key differs (a date, the tags): held in the preview with the key named, outside the approved set; the other pages apply, and a page edited since the preview declines alone with exit 0', () => managedBrain(async ({ engine, root }) => {
    const slugs = ['notes/grand-example', 'notes/retyped-example', 'notes/dated-example', 'notes/tagged-example'];
    await seedPages(engine, root, slugs);
    const preview = await repair(engine, slugArgs(slugs));
    expect(listedItems(preview)).toEqual(['default:notes/grand-example', 'default:notes/retyped-example']);
    expect(preview.details.held).toEqual([
      { item: 'default:notes/dated-example', reason: 'file_database_drift', keys: ['date'], next: 'gbrain sources reconcile default notes/dated-example --preview' },
      { item: 'default:notes/tagged-example', reason: 'file_database_drift', keys: ['tags'], next: 'gbrain sources reconcile default notes/tagged-example --preview' },
    ]);
    expect(preview.residuals).toMatchObject({ held_file_drift: 2 });
    const held = { dated: onDisk(root, 'notes/dated-example'), tagged: onDisk(root, 'notes/tagged-example') };
    // An approved page whose file takes a hand edit after the preview declines at apply.
    writeFileSync(join(root, 'notes/retyped-example.md'), PAGES['notes/retyped-example']!.file.replace('Retyped body.', 'Retyped body, edited by hand.'));
    const applied = await run(engine, [...slugArgs(slugs), '--apply', '--expect', preview.preview_hash]);
    expect({ applied: applied.result.applied, declined: applied.result.declined, stopped: applied.result.stopped, complete: applied.result.complete, exit: applied.exit })
      .toEqual({ applied: 1, declined: { source_changed: 1 }, stopped: undefined, complete: true, exit: 0 });
    expect(applied.result.failed.map((failed: { item: string; reason: string }) => [failed.item, failed.reason])).toEqual([['default:notes/retyped-example', 'source_changed']]);
    expect(applied.result.failed[0].message).toContain('uncoordinated local edit');
    await settleManagedGitEffects(engine);
    expect((await row(engine, 'notes/grand-example')).frontmatter.visibility).toBe('private');
    for (const slug of ['notes/retyped-example', 'notes/dated-example', 'notes/tagged-example']) expect((await row(engine, slug)).frontmatter.visibility).toBeUndefined();
    expect({ dated: onDisk(root, 'notes/dated-example'), tagged: onDisk(root, 'notes/tagged-example') }).toEqual(held);
  }, { databaseUrl, setup }), 240_000);

  test('a page that differs by stamps and by a real key is held, naming the real key and never a stamp', () => managedBrain(async ({ engine, root }) => {
    const slugs = ['notes/mixed-example', 'notes/grand-example'];
    await seedPages(engine, root, slugs);
    const preview = await repair(engine, slugArgs(slugs));
    expect(listedItems(preview)).toEqual(['default:notes/grand-example']);
    expect(preview.details.held).toEqual([{ item: 'default:notes/mixed-example', reason: 'file_database_drift', keys: ['date'], next: 'gbrain sources reconcile default notes/mixed-example --preview' }]);
    expect(preview.warnings.join(' ')).toContain('1 page(s) are held');
    expect(JSON.stringify(preview.details.held)).not.toMatch(/validate|legacy_type|"type"/);
  }, { databaseUrl, setup }), 240_000);

  test('the preview hash does not change when a held page\'s file changes, and the approved set still applies', () => managedBrain(async ({ engine, root }) => {
    const slugs = ['notes/grand-example', 'notes/dated-example'];
    await seedPages(engine, root, slugs);
    const first = await repair(engine, slugArgs(slugs));
    expect(first.details.held.map((hold: { item: string }) => hold.item)).toEqual(['default:notes/dated-example']);
    writeFileSync(join(root, 'notes/dated-example.md'), PAGES['notes/dated-example']!.file.replace('Dated body.', 'Dated body, edited again.'));
    const second = await repair(engine, slugArgs(slugs));
    expect(second.preview_hash).toBe(first.preview_hash);
    expect(second.details.held).toEqual([{ item: 'default:notes/dated-example', reason: 'file_database_drift', keys: ['date', 'body'], next: 'gbrain sources reconcile default notes/dated-example --preview' }]);
    const applied = await run(engine, [...slugArgs(slugs), '--apply', '--expect', first.preview_hash]);
    expect({ applied: applied.result.applied, failed: applied.result.failed, exit: applied.exit }).toEqual({ applied: 1, failed: [], exit: 0 });
    expect((await row(engine, 'notes/dated-example')).frontmatter.visibility).toBeUndefined();
  }, { databaseUrl, setup }), 240_000);

  test('a refusal mid-batch does not stop the other pages: stamped pages apply around a page edited since the preview and one whose label line can no longer be edited', () => managedBrain(async ({ engine, root }) => {
    const slugs = [1, 2, 3, 4, 5, 6].map(n => 'notes/batch-' + n);
    await seed(engine, root, Object.fromEntries(slugs.map(slug => [slug, framed(slug)])), Object.fromEntries(slugs.map(slug => [slug, PAGES['notes/grand-example']!.stamp])));
    const preview = await repair(engine, slugArgs(slugs));
    expect(listedItems(preview)).toEqual(slugs.map(slug => 'default:' + slug).sort());
    // batch-3: the same page without a frontmatter block (no label line to edit); batch-5: a hand edit.
    writeFileSync(join(root, 'notes/batch-3.md'), bare('notes/batch-3'));
    writeFileSync(join(root, 'notes/batch-5.md'), framed('notes/batch-5').replace('Body of', 'Edited body of'));
    const applied = await run(engine, [...slugArgs(slugs), '--apply', '--expect', preview.preview_hash]);
    expect({ applied: applied.result.applied, declined: applied.result.declined, stopped: applied.result.stopped, complete: applied.result.complete, exit: applied.exit })
      .toEqual({ applied: 4, declined: { label_edit_refused: 1, source_changed: 1 }, stopped: undefined, complete: true, exit: 0 });
    expect(applied.result.failed.map((failed: { item: string; reason: string }) => [failed.item, failed.reason]).sort())
      .toEqual([['default:notes/batch-3', 'label_edit_refused'], ['default:notes/batch-5', 'source_changed']]);
    expect(applied.result.failed.find((failed: { item: string }) => failed.item === 'default:notes/batch-3').message).toContain('visibility line cannot be edited as one line');
    await settleManagedGitEffects(engine);
    for (const slug of ['notes/batch-1', 'notes/batch-2', 'notes/batch-4', 'notes/batch-6']) {
      expect(onDisk(root, slug)).toBe(withVisibility(framed(slug)));
      expect((await row(engine, slug)).frontmatter).toMatchObject({ visibility: 'private', validate: false });
    }
    expect(onDisk(root, 'notes/batch-3')).toBe(bare('notes/batch-3'));
  }, { databaseUrl, setup }), 240_000);

  test('label-edit refusals never count toward item_failures_systemic: five pages whose label line cannot be edited decline, the sixth applies, and the next preview holds them', () => managedBrain(async ({ engine, root }) => {
    const slugs = [1, 2, 3, 4, 5, 6].map(n => 'notes/line-' + n);
    await seed(engine, root, Object.fromEntries(slugs.map(slug => [slug, framed(slug)])));
    const preview = await repair(engine, slugArgs(slugs));
    for (const slug of slugs.slice(0, 5)) writeFileSync(join(root, slug + '.md'), bare(slug));
    const applied = await run(engine, [...slugArgs(slugs), '--apply', '--expect', preview.preview_hash]);
    expect({ applied: applied.result.applied, declined: applied.result.declined, stopped: applied.result.stopped, complete: applied.result.complete, exit: applied.exit })
      .toEqual({ applied: 1, declined: { label_edit_refused: 5 }, stopped: undefined, complete: true, exit: 0 });
    const next = await repair(engine, slugArgs(slugs));
    expect(listedItems(next)).toEqual([]);
    expect(next.details.held.map((hold: { item: string; reason: string; keys: string[] }) => [hold.item, hold.reason, hold.keys])).toEqual(slugs.slice(0, 5).map(slug => ['default:' + slug, 'label_edit_refused', []]));
    expect(next.details.held[0].next).toContain('write visibility as one plain line');
  }, { databaseUrl, setup }), 240_000);

  test('a --readers apply declines pages whose readable_by line its file cannot take at publish: label_edit_refused, never item_failures_systemic, exit 0', () => managedBrain(async ({ engine, root }) => {
    const slugs = [1, 2, 3, 4, 5, 6].map(n => 'notes/readers-' + n);
    // Five files write readable_by as a block list, which a label-only write cannot splice; the preview holds none of them, so the managed publish refuses.
    await seed(engine, root, Object.fromEntries(slugs.map((slug, index) => [slug, note('Readers ' + (index + 1), index < 5 ? ['readable_by:', '  - bob-example'] : [], 'Readers body.')])));
    await addMember(engine, 'alice-example');
    const argv = ['visibility', ...slugs.flatMap(slug => ['--slug', slug]), '--readers', 'alice-example', '--allow-without-owner'];
    const { applied, exit } = await previewApply(engine, argv);
    expect({ applied: applied.applied, declined: applied.declined, stopped: applied.stopped, complete: applied.complete, exit })
      .toEqual({ applied: 1, declined: { label_edit_refused: 5 }, stopped: undefined, complete: true, exit: 0 });
    expect(applied.failed.map((failed: { item: string; reason: string }) => [failed.item, failed.reason]).sort()).toEqual(slugs.slice(0, 5).map(slug => ['default:' + slug, 'label_edit_refused']));
    await settleManagedGitEffects(engine);
    expect(onDisk(root, 'notes/readers-1')).toBe(note('Readers 1', ['readable_by:', '  - bob-example'], 'Readers body.'));
  }, { databaseUrl, setup }), 240_000);

  test('repair private-labels clears a label on a page with gbrain\'s stamps, changing only the label line', () => managedBrain(async ({ engine, root }) => {
    const slug = 'notes/labelled-example';
    await seed(engine, root, { [slug]: note('Labelled', ['type: note', 'access: private'], 'Labelled body.') },
      { [slug]: "type='media', frontmatter=frontmatter || '{\"legacy_type\":\"note\",\"validate\":false}'::jsonb" });
    const before = onDisk(root, slug);
    const { applied, exit } = await previewApply(engine, ['private-labels']);
    expect({ applied: applied.applied, failed: applied.failed, exit }).toEqual({ applied: 1, failed: [], exit: 0 });
    await settleManagedGitEffects(engine);
    expect(onDisk(root, slug)).toBe(before.replace('access: private' + NL, ''));
    expect((await row(engine, slug)).frontmatter).toMatchObject({ legacy_type: 'note', validate: false });
  }, { databaseUrl, setup }), 240_000);
});

/** A brain with no managed persistence (the default keyless install) whose pages carry gbrain's stamps. */
for (const backend of testBackends()) describe('[' + backend + '] label repairs over derived stamps without managed persistence', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  async function brain(fn: (engine: BrainEngine, home: string) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-gst2603-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try { await fn(engine, home); } finally { _resetWriteThroughCacheForTest(); await disposePersistenceConsumer(engine); await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  test('a repo-less brain labels a stamped page in the database only', () => brain(async engine => {
    const slug = 'notes/retyped-example';
    expect((await importFromContent(engine, slug, PAGES[slug]!.file, { noEmbed: true, sourceId: 'default' })).status).toBe('imported');
    await stampRow(engine, 'default', slug, "type='media', frontmatter=frontmatter || '{\"legacy_type\":\"note\",\"validate\":false}'::jsonb");
    const { preview, applied, exit } = await previewApply(engine, ['visibility', '--source', 'default', '--slug', slug]);
    expect(preview.details?.held).toBeUndefined();
    expect({ applied: applied.applied, failed: applied.failed, exit }).toEqual({ applied: 1, failed: [], exit: 0 });
    expect(await row(engine, slug)).toMatchObject({ type: 'media', frontmatter: expect.objectContaining({ visibility: 'private', legacy_type: 'note', validate: false }) });
  }), 180_000);

  test('a page whose file is in its source\'s checkout gets only the visibility line in that file', () => brain(async (engine, home) => {
    const slug = 'notes/grand-example', checkout = join(home, 'checkout'), path = join(checkout, slug + '.md');
    mkdirSync(join(checkout, 'notes'), { recursive: true });
    const before = PAGES[slug]!.file;
    writeFileSync(path, before);
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('source-b', 'source-b', $1) ON CONFLICT (id) DO NOTHING", [checkout]);
    expect((await importFromContent(engine, slug, before, { noEmbed: true, sourceId: 'source-b' })).status).toBe('imported');
    await stampRow(engine, 'source-b', slug, "source_path='" + slug + ".md', frontmatter=frontmatter || '{\"validate\":false}'::jsonb");
    const { applied, exit } = await previewApply(engine, ['visibility', '--source', 'source-b', '--slug', slug]);
    expect({ applied: applied.applied, failed: applied.failed, exit }).toEqual({ applied: 1, failed: [], exit: 0 });
    expect(readFileSync(path, 'utf8')).toBe(withVisibility(before));
    expect((await row(engine, slug, 'source-b')).frontmatter).toMatchObject({ visibility: 'private', validate: false });
  }), 180_000);

  test('an exact-page access rule is a readers list, not the private label: its named reader reads the page, which the label repair\'s private page hides from that reader', () => brain(async engine => {
    for (const slug of ['notes/labelled-example', 'notes/ruled-example']) {
      expect((await importFromContent(engine, slug, note('Page', [], 'Body canary-' + slug.replace(/\//g, '-') + '.'), { noEmbed: true, sourceId: 'default' })).status).toBe('imported');
    }
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('owner-example'), ('alice-example') ON CONFLICT DO NOTHING");
    await engine.setConfig('access.owner_member', 'owner-example');
    const { applied } = await previewApply(engine, ['visibility', '--source', 'default', '--slug', 'notes/labelled-example']);
    expect(applied.applied).toBe(1);
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); });
    try { await runAccessRules(engine, 'rule', ['add', '--slug', 'notes/ruled-example', '--readers', 'alice-example', '--source', 'default', '--yes', '--json'], true); } finally { spy.mockRestore(); }
    expect(JSON.parse(lines.join(NL)).state).toBe('applied');
    expect((await row(engine, 'notes/labelled-example')).frontmatter.visibility).toBe('private');
    expect((await row(engine, 'notes/ruled-example')).frontmatter.visibility).toBeUndefined();
    const tokens: Record<string, string> = {};
    for (const who of ['alice', 'unbound'] as const) {
      const minted = await mintLegacyToken(engine, { name: 'gst2603-' + who, scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
      tokens[who] = minted.token;
      if (who === 'alice') await engine.executeRaw("UPDATE access_tokens SET member_id = 'alice-example' WHERE id = $1::uuid", [minted.id]);
    }
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    __resetPrivateVisibilityCacheForTests();
    const reads = async (who: 'alice' | 'unbound', slug: string) => {
      const auth = await provider.verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
      return out.isError !== true && out.content.map(c => c.text).join(NL).includes('canary-' + slug.replace(/\//g, '-'));
    };
    expect({ labelled: await reads('alice', 'notes/labelled-example'), ruled: await reads('alice', 'notes/ruled-example') }).toEqual({ labelled: false, ruled: true });
    expect({ labelled: await reads('unbound', 'notes/labelled-example'), ruled: await reads('unbound', 'notes/ruled-example') }).toEqual({ labelled: false, ruled: false });
  }), 180_000);
  const twin = 'notes/shared-example';
  async function twinBrain(engine: BrainEngine) {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT (id) DO NOTHING");
    for (const sourceId of ['default', 'source-b']) expect((await importFromContent(engine, twin, note('Shared', [], 'Shared body in ' + sourceId + '.'), { noEmbed: true, sourceId })).status).toBe('imported');
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('owner-example'), ('alice-example') ON CONFLICT DO NOTHING");
    await engine.setConfig('access.owner_member', 'owner-example');
  }
  const rules = async (engine: BrainEngine, argv: string[]) => {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); });
    try { await runAccessRules(engine, 'rule', [...argv, '--json'], true); } finally { spy.mockRestore(); }
    return JSON.parse(lines.join(NL));
  };

  test('labelling a page in one source names the same-slug page another source leaves open, with its count and the covering command; a private twin is named nowhere', () => brain(async engine => {
    await twinBrain(engine);
    const argv = ['visibility', '--source', 'default', '--slug', twin];
    const open = await repair(engine, argv);
    expect(open.details.open_twins).toEqual({ count: 1, twins: [{ source_id: 'source-b', slug: twin, twin_of: 'default:' + twin }], commands: ['gbrain repair visibility --source source-b --slug ' + twin] });
    expect(open.residuals.open_twins).toBe(1);
    expect(open.warnings.join(NL)).toContain('1 live page(s) in other sources share a slug with a page this changes');
    await stampRow(engine, 'source-b', twin, "frontmatter=frontmatter || '{\"visibility\":\"private\"}'::jsonb");
    const covered = await repair(engine, argv);
    expect({ twins: covered.details?.open_twins, residual: covered.residuals.open_twins, hash: covered.preview_hash }).toEqual({ twins: undefined, residual: undefined, hash: open.preview_hash });
    expect((await run(engine, [...argv, '--apply', '--expect', open.preview_hash])).result.applied).toBe(1);
  }), 180_000);

  test('ruling a page in one source names the same-slug page another source leaves open, with its count and the covering rule; a twin ruled for the same reader is named nowhere', () => brain(async (engine, home) => {
    await twinBrain(engine);
    const file = join(home, 'access.yml');
    writeFileSync(file, ['version: 1', 'rules:', '  - slug: ' + twin, '    readable_by: [alice-example]', ''].join(NL));
    const open = await rules(engine, ['import', '--file', file, '--source', 'default']);
    expect(open.open_twins).toEqual({ count: 1, twins: [{ source_id: 'source-b', slug: twin, twin_of: 'default:' + twin }], commands: ['gbrain access rule add --slug ' + twin + ' --readers alice-example --source source-b'] });
    expect((await rules(engine, ['add', '--slug', twin, '--readers', 'alice-example', '--source', 'source-b', '--yes'])).state).toBe('applied');
    expect((await rules(engine, ['import', '--file', file, '--source', 'default'])).open_twins).toEqual({ count: 0, twins: [], commands: [] });
  }), 180_000);
});
