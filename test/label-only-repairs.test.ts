/**
 * GST-2468: an operator repair that only changes privacy labels is not an agent content write.
 *
 * 1. Protects: gbrain repair visibility (its alias class and the slug-bound --slug form an operator uses for one page) and
 *    gbrain repair private-labels (clear and restore) keep the page's trust tier, file no lower_page proposal and change
 *    only the label lines of the page's file, on a file whose frontmatter has a slug key, a source_kind the row's
 *    provenance column does not hold, and keys in a non-canonical order. A plain local put_page that adds the same label
 *    still lowers the page and files its proposal, as an agent edit does (trust/channel.ts). gbrain trust backfill
 *    --label-lowerings lists each lower_page proposal as label-only or content, by proposer, and changes nothing.
 * 2. Fails when: a label repair lowers the tier, files a proposal, re-renders the file (a key dropped, a value or the key
 *    order changed, a provenance stamp or trust marker added), or a plain put_page stops lowering.
 * 3. Real seams: the managed-brain harness (claimed Git worktree, managed sync, the maintenance door, the Git effect),
 *    remote:false, the gbrain repair command entry; a repo-less brain with no managed persistence. PGLite, and Postgres
 *    with DATABASE_URL.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { renderRepairResult, runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { listLabelLowerings, renderLabelLowerings } from '../src/core/trust/label-lowerings.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const NL = String.fromCharCode(10);
const putPage = operations.find(op => op.name === 'put_page')!;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
/** Keys out of canonical order, a slug key, provenance stamps (source_kind, ingested_via) the provenance columns do not hold. */
const file = (slug: string, labels = '') => ['---', 'title: Example Page', 'slug: ' + slug, 'source_kind: email-example', 'ingested_via: connector-example', 'type: note', ...(labels ? [labels] : []),
  'owner_note: kept', 'tags:', '  - alpha', '---', '', 'Body line one of ' + slug + '.', '', 'Second paragraph.', ''].join(NL);
const withLine = (text: string, line: string) => text.replace(NL + 'tags:', NL + 'tags:').replace(NL + '---' + NL + NL, NL + line + NL + '---' + NL + NL);

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log;
  console.log = (...parts: unknown[]) => { printed += parts.map(String).join(' ') + NL; };
  try { await fn(); } finally { console.log = original; }
  return printed;
}
const repair = async (engine: BrainEngine, argv: string[]) => {
  const out = await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() => runRepairCommand(engine, [...argv, '--json'])));
  _resetCliExitVerdictForTests();
  return JSON.parse(out).results[0];
};
const previewApply = async (engine: BrainEngine, argv: string[]) => {
  const preview = await repair(engine, argv);
  expect(preview.preview_hash).toBeString();
  const applied = await repair(engine, [...argv, '--apply', '--expect', preview.preview_hash]);
  expect(applied.failed).toEqual([]);
  return { preview, applied };
};
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ tier: string; frontmatter: Record<string, unknown>; revision: string; source_kind: string | null }>(
  "SELECT trust_tier::text AS tier, frontmatter, knowledge_revision::text AS revision, source_kind FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]))[0]!;
const proposals = async (engine: BrainEngine) => engine.executeRaw<{ proposer: string; status: string }>('SELECT proposer, status FROM trust_proposals ORDER BY id');

for (const backend of testBackends()) describe('[' + backend + '] label-only operator repairs on a managed git source', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), 'archive/' + NL); durableGitRepo(root, ['.gitignore']); };
  async function seed(engine: BrainEngine, root: string, files: Record<string, string>) {
    mkdirSync(join(root, 'notes'), { recursive: true });
    for (const [slug, text] of Object.entries(files)) writeFileSync(join(root, slug + '.md'), text);
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'owner notes');
    await performManagedSync(engine, OPTS);
    await settleManagedGitEffects(engine);
    for (const slug of Object.keys(files)) expect((await page(engine, slug)).tier).toBe('operator_curated');
  }
  const onDisk = (root: string, slug: string) => readFileSync(join(root, slug + '.md'), 'utf8');

  test('repair visibility --slug: tier kept, no proposal, the file gains only the visibility line', () => managedBrain(async ({ engine, root }) => {
    const slug = 'notes/one-example';
    await seed(engine, root, { [slug]: file(slug) });
    expect((await page(engine, slug)).source_kind).toBeNull();
    const before = onDisk(root, slug);
    const { preview, applied } = await previewApply(engine, ['visibility', '--slug', slug]);
    expect(preview.listing).toEqual([{ item: 'default:' + slug, class: 'pages', detail: 'visibility (none) -> private' }]);
    expect(applied.applied).toBe(1);
    await settleManagedGitEffects(engine);
    const after = await page(engine, slug);
    expect(after.tier).toBe('operator_curated');
    expect(after.frontmatter.visibility).toBe('private');
    expect(after.frontmatter.source_kind).toBe('email-example');
    expect(after.frontmatter.ingested_via).toBe('connector-example');
    expect(await proposals(engine)).toEqual([]);
    expect(onDisk(root, slug)).toBe(withLine(before, 'visibility: private'));
    expect(git(root, 'status', '--porcelain', '--', slug + '.md').trim()).toBe('');
    expect(git(root, 'show', 'HEAD:' + slug + '.md')).toBe(withLine(before, 'visibility: private'));
    // Tighten-only: the page is private now, so a second preview names nothing.
    expect((await repair(engine, ['visibility', '--slug', slug])).listing).toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test('repair visibility --slug refuses a bare --apply and --class beside it', () => managedBrain(async ({ engine }) => {
    const refused = (argv: string[]) => repair(engine, argv).then(result => JSON.stringify(result), (error: Error) => error.message);
    expect(await refused(['visibility', '--slug', 'notes/x-example', '--apply'])).toContain('applies only the set a preview printed');
    expect(await refused(['visibility', '--slug', 'notes/x-example', '--class', 'aliases'])).toContain('takes --slug or --class, not both');
  }, { databaseUrl, setup }), 120_000);

  test('repair visibility aliases: tier kept, no proposal, the file gains only the visibility line', () => managedBrain(async ({ engine, root }) => {
    const slug = 'notes/alias-example';
    await seed(engine, root, { [slug]: file(slug, 'access: private') });
    const before = onDisk(root, slug);
    const { applied } = await previewApply(engine, ['visibility', '--class', 'aliases']);
    expect(applied.applied).toBe(1);
    await settleManagedGitEffects(engine);
    expect((await page(engine, slug)).tier).toBe('operator_curated');
    expect(await proposals(engine)).toEqual([]);
    expect(onDisk(root, slug)).toBe(withLine(before, 'visibility: private'));
  }, { databaseUrl, setup }), 180_000);

  test('repair visibility facts: the fence row turns private in place, the page keeps its tier, and its file changes only in the fact row', () => managedBrain(async ({ engine, root }) => {
    const slug = 'notes/fact-example';
    const header = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |' + NL
      + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|' + NL;
    const withFacts = (visibility: string) => file(slug, 'visibility: private').replace('Second paragraph.' + NL, 'Second paragraph.' + NL + NL + '## Facts' + NL + NL
      + '<!--- gbrain:facts:begin -->' + NL + NL + header + '| 1 | Alice Example works at acme-example. | fact | 1.0 | ' + visibility + ' | medium | 2026-10-01 |  | test |  |' + NL
      + '<!--- gbrain:facts:end -->' + NL);
    await seed(engine, root, { [slug]: withFacts('world') });
    const live = "SELECT id, visibility, trust_tier::text AS tier FROM facts WHERE source_markdown_slug=$1 AND expired_at IS NULL ORDER BY id";
    const [before] = await engine.executeRaw<{ id: number; visibility: string; tier: string }>(live, [slug]);
    expect(before).toMatchObject({ visibility: 'world', tier: 'operator_curated' });
    const { applied } = await previewApply(engine, ['visibility', '--class', 'facts']);
    await settleManagedGitEffects(engine);
    // GST-2487: the more trusted row is the one made private, in place: no world copy stays live and no contest is filed.
    expect(applied.applied).toBe(1);
    expect(applied.outcomes ?? {}).toEqual({});
    expect(await engine.executeRaw(live, [slug])).toEqual([{ id: before!.id, visibility: 'private', tier: 'operator_curated' }]);
    expect((await page(engine, slug)).tier).toBe('operator_curated');
    expect(await proposals(engine)).toEqual([]);
    expect(onDisk(root, slug)).toBe(withFacts('private'));
    expect((await repair(engine, ['visibility', '--class', 'facts'])).listing ?? []).toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test('repair visibility --slug on a database-only page (a db_only path) writes only the label: tier and provenance kept, no file', () => managedBrain(async ({ engine, root, ctx }) => {
    const slug = 'email/mail-example';
    await putPage.handler(ctx, { slug, content: file(slug), request_id: randomUUID(), wait_ms: 30_000 });
    await settleManagedGitEffects(engine);
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      "UPDATE pages SET source_kind='mail-example', ingested_via='connector-example', ingested_at='2026-01-02T00:00:00Z' WHERE source_id='default' AND slug=$1", [slug]), TEST_WRITE_ATTRIBUTION));
    const stamps = "SELECT trust_tier::text AS tier, source_kind, ingested_via, ingested_at FROM pages WHERE source_id='default' AND slug=$1";
    const before = (await engine.executeRaw(stamps, [slug]))[0];
    const proposalsBefore = await proposals(engine);
    const frontmatter = (await page(engine, slug)).frontmatter;
    const { applied } = await previewApply(engine, ['visibility', '--slug', slug]);
    await settleManagedGitEffects(engine);
    expect(applied.applied).toBe(1);
    expect((await engine.executeRaw(stamps, [slug]))[0]).toEqual(before);
    expect((await page(engine, slug)).frontmatter).toEqual({ ...frontmatter, visibility: 'private' });
    expect(await proposals(engine)).toEqual(proposalsBefore);
    expect(git(root, 'ls-files', 'email').trim()).toBe('email/.keep');
  }, { databaseUrl, setup: ({ root }) => {
    writeFileSync(join(root, '.gitignore'), 'archive/' + NL);
    writeFileSync(join(root, 'gbrain.yml'), 'storage:' + NL + '  db_only:' + NL + '    - email' + NL);
    mkdirSync(join(root, 'email'), { recursive: true });
    writeFileSync(join(root, 'email', '.keep'), '');
    durableGitRepo(root, ['.gitignore', 'gbrain.yml', 'email/.keep']);
  } }), 180_000);

  test('repair private-labels clear and restore change only the label lines, and keep the tier', () => managedBrain(async ({ engine, root }) => {
    const slug = 'notes/labelled-example';
    await seed(engine, root, { [slug]: file(slug, 'access: private') });
    const before = onDisk(root, slug);
    const cleared = await previewApply(engine, ['private-labels']);
    expect(cleared.applied.applied).toBe(1);
    await settleManagedGitEffects(engine);
    expect(onDisk(root, slug)).toBe(before.replace('access: private' + NL, ''));
    expect((await page(engine, slug)).tier).toBe('operator_curated');
    const restored = await previewApply(engine, ['private-labels', '--class', 'restore']);
    expect(restored.applied.applied).toBe(1);
    await settleManagedGitEffects(engine);
    // The restored line is the frontmatter's last line: a label edit appends a key it adds, keeping every other byte.
    expect(onDisk(root, slug)).toBe(withLine(before.replace('access: private' + NL, ''), 'access: private'));
    expect((await page(engine, slug)).tier).toBe('operator_curated');
    expect(await proposals(engine)).toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test('a plain put_page that adds the label still lowers, files its proposal, and the listing calls it label-only', () => managedBrain(async ({ engine, ctx, root }) => {
    const labelled = 'notes/put-example', edited = 'notes/edit-example';
    await seed(engine, root, { [labelled]: file(labelled), [edited]: file(edited) });
    const first = await putPage.handler(ctx, { slug: labelled, content: withLine(file(labelled), 'visibility: private'), request_id: randomUUID(), wait_ms: 30_000,
      expected_revision: (await page(engine, labelled)).revision }) as Record<string, any>;
    expect(first.trust_lowered?.proposal_ref).toMatch(/^tp\d+$/);
    expect((await page(engine, labelled)).tier).toBe('agent_written');
    await putPage.handler(ctx, { slug: edited, content: file(edited).replace('Second paragraph.', 'An agent rewrote this paragraph.'), request_id: randomUUID(),
      wait_ms: 30_000, expected_revision: (await page(engine, edited)).revision });
    expect((await proposals(engine)).map(p => p.proposer)).toEqual(['agent_page_edit:put_page', 'agent_page_edit:put_page']);
    const tiersBefore = await engine.executeRaw('SELECT slug, trust_tier::text FROM pages ORDER BY slug');
    const report = await listLabelLowerings(engine);
    expect(report.counts).toEqual({ lower_page: 2, label_only: 1, content: 1, unreadable: 0,
      by_proposer: { 'agent_page_edit:put_page': { label_only: 1, content: 1, unreadable: 0 } } });
    const item = report.items.find(entry => entry.class === 'label_only')!;
    expect(item).toMatchObject({ source_id: 'default', slug: labelled, proposer: 'agent_page_edit:put_page', status: 'pending',
      prior_tier: 'operator_curated', tier_now: 'agent_written', labels: { visibility: { before: null, now: 'private' } } });
    expect(item.stamps).toContain('trust_tier');
    expect(report.items.find(entry => entry.class === 'content')!.slug).toBe(edited);
    expect(renderLabelLowerings(report)).toContain('visibility (none) -> private');
    expect((await listLabelLowerings(engine, { sourceId: 'other-example' })).counts.lower_page).toBe(0);
    expect(await engine.executeRaw('SELECT slug, trust_tier::text FROM pages ORDER BY slug')).toEqual(tiersBefore);
  }, { databaseUrl, setup }), 180_000);
});

/** A repo-less brain (no managed persistence, no checkout: the default keyless install) is the database record. */
for (const backend of testBackends()) describe('[' + backend + '] label-only operator repairs on a repo-less brain', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('repair visibility --slug keeps the tier and files no proposal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-label-repoless-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          const seed = async (sourceId: string, slug: string) => {
            expect((await importFromContent(engine, slug, file(slug), { noEmbed: true, sourceId })).status).toBe('imported');
            await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => withTrustBackfill(tx, () =>
              tx.executeRaw("UPDATE pages SET trust_tier='operator_curated', source_kind='mail-example', ingested_via='connector-example', ingested_at='2026-01-02T00:00:00Z' WHERE source_id=$1 AND slug=$2", [sourceId, slug])), TEST_WRITE_ATTRIBUTION));
          };
          await seed('default', 'notes/plain-example');
          const stamps = "SELECT source_kind, ingested_via, ingested_at FROM pages WHERE source_id='default' AND slug='notes/plain-example'";
          const stamped = await engine.executeRaw(stamps);
          const { applied } = await previewApply(engine, ['visibility', '--source', 'default', '--slug', 'notes/plain-example']);
          expect(applied.applied).toBe(1);
          const [row] = await engine.executeRaw<{ tier: string; visibility: string }>(
            "SELECT trust_tier::text AS tier, frontmatter->>'visibility' AS visibility FROM pages WHERE source_id='default' AND slug='notes/plain-example'");
          expect(row).toEqual({ tier: 'operator_curated', visibility: 'private' });
          expect(await engine.executeRaw(stamps)).toEqual(stamped);
          expect(await proposals(engine)).toEqual([]);
          expect((await listLabelLowerings(engine)).counts.lower_page).toBe(0);
        } finally { await disposePersistenceConsumer(engine); await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 180_000);

  test('repair visibility facts turns a more trusted fence row private in place: no world copy, tier kept, no contest', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-label-repoless-facts-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          const slug = 'notes/fact-example';
          const fence = '## Facts' + NL + NL + '<!--- gbrain:facts:begin -->' + NL + NL
            + '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |' + NL
            + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|' + NL
            + '| 1 | Alice Example works at acme-example. | fact | 1.0 | world | medium | 2026-10-01 |  | test |  |' + NL + '<!--- gbrain:facts:end -->' + NL;
          const content = file(slug, 'visibility: private').replace('Second paragraph.' + NL, 'Second paragraph.' + NL + NL + fence);
          expect((await importFromContent(engine, slug, content, { noEmbed: true, sourceId: 'default' })).status).toBe('imported');
          await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => withTrustBackfill(tx, async () => {
            await tx.executeRaw("UPDATE pages SET trust_tier='operator_curated' WHERE source_id='default' AND slug=$1", [slug]);
            await tx.executeRaw("INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, source_markdown_slug, row_num, valid_from, trust_tier) VALUES ('default', NULL, 'Alice Example works at acme-example.', 'fact', 'world', 'medium', 'test', $1, 1, '2026-10-01', 'operator_curated')", [slug]);
          }), TEST_WRITE_ATTRIBUTION));
          const live = "SELECT id, visibility, trust_tier::text AS tier FROM facts WHERE source_markdown_slug=$1 AND expired_at IS NULL ORDER BY id";
          const [before] = await engine.executeRaw<{ id: number; visibility: string; tier: string }>(live, [slug]);
          expect(before).toMatchObject({ visibility: 'world', tier: 'operator_curated' });
          const { applied } = await previewApply(engine, ['visibility', '--source', 'default', '--class', 'facts']);
          expect(applied.applied).toBe(1);
          expect(applied.outcomes ?? {}).toEqual({});
          expect(await engine.executeRaw(live, [slug])).toEqual([{ id: before!.id, visibility: 'private', tier: 'operator_curated' }]);
          expect((await page(engine, slug)).tier).toBe('operator_curated');
          expect(await proposals(engine)).toEqual([]);
        } finally { await disposePersistenceConsumer(engine); await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 180_000);

  /** A brain without managed persistence whose source `source-b` has a checkout holding the page's file. */
  async function checkoutBrain(fn: (brain: { engine: BrainEngine; slug: string; path: string; before: string; row: () => Promise<{ tier: string; frontmatter: Record<string, unknown> }> }) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-label-checkout-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          const slug = 'notes/filed-example', checkout = join(home, 'checkout'), path = join(checkout, slug + '.md');
          mkdirSync(join(checkout, 'notes'), { recursive: true });
          const before = file(slug);
          writeFileSync(path, before);
          await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('source-b', 'source-b', $1) ON CONFLICT (id) DO NOTHING", [checkout]);
          expect((await importFromContent(engine, slug, before, { noEmbed: true, sourceId: 'source-b' })).status).toBe('imported');
          await engine.transaction(tx => withCoordinatedWrite(tx, ['source-b'], () => withTrustBackfill(tx, () =>
            tx.executeRaw("UPDATE pages SET trust_tier='operator_curated', source_path=$2 WHERE source_id='source-b' AND slug=$1", [slug, slug + '.md'])), TEST_WRITE_ATTRIBUTION));
          const row = async () => (await engine.executeRaw<{ tier: string; frontmatter: Record<string, unknown> }>(
            "SELECT trust_tier::text AS tier, frontmatter FROM pages WHERE source_id='source-b' AND slug=$1", [slug]))[0]!;
          await fn({ engine, slug, path, before, row });
        } finally { _resetWriteThroughCacheForTest(); await disposePersistenceConsumer(engine); await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const slugRepair = (slug: string) => ['visibility', '--source', 'source-b', '--slug', slug];

  test('without managed persistence, a page whose file is in a checkout gets the same label-line splice in its file', () => checkoutBrain(async ({ engine, slug, path, before, row }) => {
    const { applied } = await previewApply(engine, slugRepair(slug));
    expect(applied.applied).toBe(1);
    const stored = await row();
    expect(stored.tier).toBe('operator_curated');
    expect(stored.frontmatter.visibility).toBe('private');
    expect(stored.frontmatter.source_kind).toBe('email-example');
    expect(stored.frontmatter.ingested_via).toBe('connector-example');
    expect(await proposals(engine)).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(withLine(before, 'visibility: private'));
  }), 180_000);

  test('a checkout file holding an edit the database lacks refuses, and neither the file nor the row changes', () => checkoutBrain(async ({ engine, slug, path, before, row }) => {
    const preview = await repair(engine, slugRepair(slug));
    const edited = before.replace('Second paragraph.', 'Second paragraph, edited by hand.');
    writeFileSync(path, edited);
    const applied = await repair(engine, [...slugRepair(slug), '--apply', '--expect', preview.preview_hash]);
    expect(applied.applied).toBe(0);
    expect(applied.failed).toEqual([expect.objectContaining({ item: 'source-b:' + slug, reason: 'source_changed' })]);
    expect(readFileSync(path, 'utf8')).toBe(edited);
    expect((await row()).frontmatter.visibility).toBeUndefined();
  }), 180_000);

  test('with sync.write_through off, the page is held file_backed instead of written to the database alone', () => checkoutBrain(async ({ engine, slug, path, before, row }) => {
    await engine.setConfig('sync.write_through', 'false');
    _resetWriteThroughCacheForTest();
    const { applied } = await previewApply(engine, slugRepair(slug));
    expect(applied.applied).toBe(0);
    expect(applied.outcome_items).toEqual([expect.objectContaining({ item: 'source-b:' + slug, outcome: 'file_backed' })]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect((await row()).frontmatter.visibility).toBeUndefined();
  }), 180_000);

  test.skipIf(process.getuid?.() === 0)('a file write that fails rolls the database back and holds the page', () => checkoutBrain(async ({ engine, slug, path, before, row }) => {
    const dir = join(path, '..');
    chmodSync(dir, 0o555);
    try {
      const { applied } = await previewApply(engine, slugRepair(slug));
      expect(applied.applied).toBe(0);
      expect(applied.outcome_items).toEqual([expect.objectContaining({ item: 'source-b:' + slug, outcome: 'file_backed' })]);
    } finally { chmodSync(dir, 0o755); }
    expect(readFileSync(path, 'utf8')).toBe(before);
    const stored = await row();
    expect(stored.frontmatter.visibility).toBeUndefined();
    expect(stored.tier).toBe('operator_curated');
  }), 180_000);
});
