/**
 * GST-327: `gbrain repair secret-spans` redacts only the secret spans in every database copy of the named pages.
 *
 * Repo-less brain (no worktree, the database is the record): an inline page whose title, frontmatter value, body,
 * timeline rows, fact, take, link context and raw data hold credentials (one glued to an existing marker, one only an
 * echo), a segmented embed_skip page over 1 MB, a page whose timeline holds an impossible date, a clean page and a
 * missing slug in one batch. Managed brain: a held page is redacted in the database while its file, its hold and Git
 * stay as they are. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { materializeSegmentedBody } from '../src/core/page-body/ingest.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { writeGitHold, GIT_HOLD_OP } from '../src/core/persistence/sync-holds.ts';
import { resolveRepairScope, runRepair, type RepairResult } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairRunner } from '../src/core/repair/registry.ts';
import { secretSpansRepair } from '../src/core/repair/secret-spans.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { parseRepairArgs } from '../src/commands/repair.ts';

const logger = { info() {}, warn() {}, error() {} };
// Obviously fake key shapes, assembled so no literal key sits in the source.
const OPENAI = ['sk', 'proj', 'EXAMPLExNOTxREALxEXAMPLExNOTxREAL'].join('-');
const AWS = 'AKIA' + 'EXAMPLENOTREAL00';
const GITHUB = 'ghp' + '_' + 'EXAMPLEnotREAL'.repeat(3);
const BEARER = 'EXAMPLEtokenNOTreal' + '1234567890abcdef';
const SECRETS = [OPENAI, AWS, GITHUB, BEARER];
const M = (rule: string) => `<REDACTED:${rule}>`;

const ALPHA_BODY = [`# Alpha Example`, '', `The deploy notes keep the old key ${OPENAI} here.`, `A pasted marker then a key: ${M('openai')}${OPENAI} glued.`,
  `Authorization: Bearer ${BEARER}`, `The token ${BEARER} appears again bare.`, 'Nothing else changes, not even this line.'].join('\n');
const ALPHA_TIMELINE = `## Timeline\n\n- **2024-01-02** | import — Rotated ${AWS} out of the build\n- **2024-03-04** | import — Unrelated entry`;
const ALPHA = `---\ntype: note\ntitle: Alpha Example\nnote_key: "copy of ${OPENAI}"\nowner: alice-example\n---\n\n${ALPHA_BODY}\n\n<!-- timeline -->\n\n${ALPHA_TIMELINE}\n`;
const filler = (tag: string, bytes: number) => Array.from({ length: Math.ceil(bytes / 1900) }, (_, i) =>
  `## ${tag} ${i}\n\n${`Runbook notes for the synthetic staging cluster, step ${i}. `.repeat(30)}\n\n`).join('');
const LARGE_BODY = `# Large Example\n\n${filler('Before', 600_000)}## Old key\n\nThe retired key was ${AWS} and nothing else.\n\n${filler('After', 600_000)}`;
const LARGE = `---\ntype: note\ntitle: Large Example\n---\n\n${LARGE_BODY}`;
const BAD_DATE = `---\ntype: note\ntitle: Bad Date Example\n---\n\nThe github token ${GITHUB} was pasted here.\n`;
const CLEAN = '---\ntype: note\ntitle: Clean Example\n---\n\nNo credentials on this page.\n';

const home = mkdtempSync(join(tmpdir(), 'gbrain-secret-spans-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const leaked = (value: unknown) => SECRETS.filter(secret => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v).includes(secret));
const pageRow = async (engine: BrainEngine, slug: string, sourceId = 'default') => (await engine.executeRaw<Record<string, any>>(
  `SELECT id,title,frontmatter,compiled_truth,timeline,body_storage,knowledge_revision::text AS revision,content_hash,trust_tier FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, slug]))[0]!;
const snapshotDb = async (engine: BrainEngine) => ({
  pages: await engine.executeRaw('SELECT id,slug,title,frontmatter,compiled_truth,timeline,knowledge_revision::text AS revision,body_generation FROM pages ORDER BY id'),
  timeline: await engine.executeRaw('SELECT id,page_id,date::text AS date,summary,detail,source FROM timeline_entries ORDER BY id'),
  facts: await engine.executeRaw('SELECT id,fact,context,embedded_at FROM facts ORDER BY id'),
  takes: await engine.executeRaw('SELECT id,claim,source FROM takes ORDER BY id'),
  links: await engine.executeRaw('SELECT id,context FROM links ORDER BY id'),
  raw: await engine.executeRaw('SELECT id,data FROM raw_data ORDER BY id'),
  chunks: await engine.executeRaw('SELECT page_id,count(*)::int AS n FROM content_chunks GROUP BY page_id ORDER BY page_id'),
  versions: await engine.executeRaw('SELECT count(*)::int AS n FROM page_versions'),
});

const repoLess: Array<{ name: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(() => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema();
  repoLess.push({ name: 'pglite', engine: lite });
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    repoLess.push({ name: 'postgres', engine: pg.engine });
    closePostgres = pg.close;
  }
}), 120_000);
afterAll(async () => { for (const { engine } of repoLess) await engine.disconnect(); await closePostgres?.(); });

async function seed(engine: BrainEngine) {
  await engine.setConfig('pages.segmented_storage', 'on');
  for (const [slug, content] of [['notes/alpha-example', ALPHA], ['notes/large-example', LARGE], ['notes/bad-date-example', BAD_DATE], ['notes/clean-example', CLEAN]] as const) {
    await importFromContent(engine, slug, content, { noEmbed: true, sourceId: 'default' });
  }
  // An older brain's size marker (the content gate no longer writes one at this size): the page gets no vectors.
  await engine.executeRaw(`UPDATE pages SET frontmatter=frontmatter||'{"embed_skip":"oversized"}'::jsonb WHERE source_id='default' AND slug='notes/large-example'`);
  // #8049 shape: a stored timeline whose bullet names a day that does not exist (an older writer stored it as text).
  await engine.executeRaw(`UPDATE pages SET timeline=$2 WHERE source_id='default' AND slug=$1`,
    ['notes/bad-date-example', `## Timeline\n\n- **2024-02-30** | import — Moved ${GITHUB} to the vault`]);
  const alpha = await pageRow(engine, 'notes/alpha-example');
  const clean = await pageRow(engine, 'notes/clean-example');
  await engine.executeRaw("INSERT INTO timeline_entries(page_id,date,source,summary,detail) VALUES ($1,'2024-01-02','import',$2,''),($1,'2024-03-04','import','Unrelated entry','')",
    [alpha.id, `Rotated ${AWS} out of the build`]);
  await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,context,source,kind) VALUES ('default','notes/alpha-example',$1,$2,'test','fact')`,
    [`The CI token is ${GITHUB}.`, `Seen next to ${AWS} in the notes`]);
  await engine.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder,source) VALUES ($1,1,$2,'take','alice-example',$3)`,
    [alpha.id, `Rotating ${OPENAI} was overdue`, 'notes']);
  await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,link_type,context) VALUES ($1,$2,'mentions',$3)`, [alpha.id, clean.id, `see ${AWS} near the clean page`]);
  await engine.executeRaw(`INSERT INTO raw_data(page_id,source,data) VALUES ($1,'test',$2::text::jsonb)`,
    [alpha.id, JSON.stringify({ request: { headers: { authorization: `Bearer ${BEARER}` }, ids: [1, 2] }, note: 'kept as is' })]);
}

describe('GST-327 gbrain repair secret-spans on a repo-less brain', () => {
  test('preview writes nothing; refusals; preview_changed; the apply redacts only the spans; a second preview is empty', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const { name, engine } of repoLess) {
      {
        await seed(engine);
        expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).not.toContain('secret-spans');
        const scope = await resolveRepairScope(engine, 'default');
        const slugs = ['notes/alpha-example', 'notes/large-example', 'notes/bad-date-example', 'notes/clean-example', 'notes/missing-example'];
        const preview = () => repairRunner(engine, { apply: false, logger }).then(runner => runner.run('secret-spans', scope, { explicit: true, sourceFlag: 'default', slugs }));
        const apply = (hash: string) => repairRunner(engine, { apply: true, logger }).then(runner => runner.run('secret-spans', scope, { explicit: true, sourceFlag: 'default', slugs, expect: hash }));

        // Explicit-only, trusted-local-CLI-only, and an apply needs a preview.
        await expect(repairRunner(engine, { apply: false, logger }).then(runner => runner.run('secret-spans', scope, { slugs }))).rejects.toThrow(/explicit/);
        const remote = { engine, config: { engine: engine.kind }, logger, dryRun: true, remote: true, sourceId: 'default' } as never;
        await expect(runRepair(remote, secretSpansRepair, scope, { apply: false, explicit: true, slugs })).rejects.toMatchObject({ code: 'permission_denied' });
        await expect(repairRunner(engine, { apply: true, logger }).then(runner => runner.run('secret-spans', scope, { explicit: true, slugs }))).rejects.toThrow(/preview/i);
        await expect(repairRunner(engine, { apply: true, logger }).then(runner => runner.run('secret-spans', scope, { explicit: true, expect: 'x' }))).rejects.toThrow(/--slug/);
        const before0 = await snapshotDb(engine);
        const unnamed = await repairRunner(engine, { apply: false, logger }).then(runner => runner.run('secret-spans', scope, { explicit: true }));
        expect({ affected: unnamed.affected, hash: unnamed.preview_hash, warning: unnamed.warnings?.[0] }).toEqual({ affected: 0, hash: undefined, warning: expect.stringContaining('--slug <slug>') });
        expect(await snapshotDb(engine)).toEqual(before0);

        const before = await snapshotDb(engine);
        const first = await preview();
        expect(first.affected, name).toBe(3);
        expect(first.listing!.map(entry => [entry.class, entry.item.split(' ')[0]])).toEqual([
          ['redact', 'default:notes/alpha-example'], ['redact', 'default:notes/bad-date-example'], ['redact', 'default:notes/large-example'],
          ['refused', 'default:notes/missing-example']]);
        expect(first.residuals).toMatchObject({ pages_to_redact: 3, clean: 1, refused: 1 });
        expect(first.apply_command).toContain(`--apply --expect ${first.preview_hash}`);
        expect(leaked(first)).toEqual([]);
        expect(await snapshotDb(engine)).toEqual(before);

        // A fact edit after the preview moves the hash: nothing is written.
        await engine.executeRaw(`UPDATE facts SET context=context||' (edited)' WHERE entity_slug='notes/alpha-example'`);
        await expect(apply(first.preview_hash!)).rejects.toMatchObject({ code: 'preview_changed' });
        const edited = await snapshotDb(engine);
        expect(edited.pages).toEqual(before.pages);

        const second = await preview();
        expect(second.preview_hash).not.toBe(first.preview_hash);
        const alphaBefore = await pageRow(engine, 'notes/alpha-example');
        const cleanBefore = await pageRow(engine, 'notes/clean-example');
        const largeBefore = await pageRow(engine, 'notes/large-example');
        const largeBody = await materializeSegmentedBody(engine, Number(largeBefore.id), 'default');
        expect(largeBody.compiled_truth).toContain(AWS);
        // The apply embeds what it changed (no key here, so each attempt logs), except the embed_skip page.
        const logged: string[] = [];
        const write = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true; }) as typeof process.stderr.write;
        const result: RepairResult = await apply(second.preview_hash!).finally(() => { process.stderr.write = write; });
        expect(logged.some(line => line.includes('notes/alpha-example'))).toBe(true);
        expect(logged.some(line => line.includes('notes/large-example'))).toBe(false);
        expect(result.applied, name).toBe(3);
        expect(result.outcomes).toEqual({ redacted: 3 });
        for (const outcome of result.outcome_items ?? []) expect(outcome.detail?.residual, outcome.item).toBe(0);
        expect(result.verification).toMatchObject({ rescanned_pages: 5, residual_matches: 0 });
        expect(leaked(result)).toEqual([]);

        // Only the spans changed, everywhere the page is stored.
        const alpha = await pageRow(engine, 'notes/alpha-example');
        expect(alpha.compiled_truth).toBe(ALPHA_BODY.replace(`${M('openai')}${OPENAI}`, `${M('openai')}${M('openai')}`)
          .replaceAll(OPENAI, M('openai')).replaceAll(BEARER, M('bearer')));
        expect(alpha.timeline).toBe(ALPHA_TIMELINE.replace(AWS, M('aws_access_key')));
        expect(alpha.frontmatter).toEqual({ ...alphaBefore.frontmatter, note_key: `copy of ${M('openai')}` });
        expect(alpha.title).toBe('Alpha Example');
        expect(alpha.revision).not.toBe(alphaBefore.revision);
        expect(alpha.trust_tier).toBe(alphaBefore.trust_tier);
        const rows = await snapshotDb(engine);
        expect(rows.timeline.map((row: any) => row.summary).join('\n')).toContain(`Rotated ${M('aws_access_key')} out of the build`);
        expect(rows.timeline.map((row: any) => row.date)).toEqual(edited.timeline.map((row: any) => row.date));
        expect(rows.facts).toEqual([expect.objectContaining({ fact: `The CI token is ${M('github_token')}.`, context: `Seen next to ${M('aws_access_key')} in the notes (edited)`, embedded_at: null })]);
        expect(rows.takes).toEqual([expect.objectContaining({ claim: `Rotating ${M('openai')} was overdue`, source: 'notes' })]);
        expect(rows.links).toEqual([expect.objectContaining({ context: `see ${M('aws_access_key')} near the clean page` })]);
        expect(rows.raw).toEqual([expect.objectContaining({ data: { request: { headers: { authorization: `Bearer ${M('bearer')}` }, ids: [1, 2] }, note: 'kept as is' } })]);
        expect(leaked(rows)).toEqual([]);
        expect(rows.versions).toEqual(before.versions);
        expect(leaked(await engine.executeRaw('SELECT chunk_text FROM content_chunks'))).toEqual([]);

        // The segmented embed_skip page: still segmented, flag kept, body identical but for the span.
        const large = await pageRow(engine, 'notes/large-example');
        expect(large.body_storage).toBe('segmented');
        expect(large.frontmatter.embed_skip).toBe('oversized');
        expect(large.revision).not.toBe(largeBefore.revision);
        expect(await materializeSegmentedBody(engine, Number(large.id), 'default'))
          .toEqual({ compiled_truth: largeBody.compiled_truth.replace(AWS, M('aws_access_key')), timeline: largeBody.timeline });

        // Every rewritten page is sealed again at its new revision, with chunks rebuilt from the redacted body.
        const sealed = await engine.executeRaw<{ slug: string; sealed: boolean; chunks: number }>(`SELECT p.slug,p.text_projection_revision=p.knowledge_revision AS sealed,
          (SELECT count(*)::int FROM content_chunks c WHERE c.page_id=p.id) AS chunks FROM pages p WHERE p.slug=ANY($1::text[]) ORDER BY p.slug`,
        [['notes/alpha-example', 'notes/large-example', 'notes/bad-date-example']]);
        for (const page of sealed) { expect(page.sealed, page.slug).toBe(true); expect(page.chunks, page.slug).toBeGreaterThan(0); }
        // The receipts are value-free.
        const receipts = await engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='secret-spans-receipt'");
        expect(receipts).toHaveLength(3);
        expect(leaked(receipts)).toEqual([]);

        // The impossible-date page was redacted in the same batch, its date left as stored.
        const bad = await pageRow(engine, 'notes/bad-date-example');
        expect(bad.timeline).toBe(`## Timeline\n\n- **2024-02-30** | import — Moved ${M('github_token')} to the vault`);

        // The clean page is untouched, and a second preview finds nothing.
        expect(await pageRow(engine, 'notes/clean-example')).toEqual(cleanBefore);
        const again = await preview();
        expect(again.affected).toBe(0);
        expect(again.residuals).toMatchObject({ pages_to_redact: 0, clean: 4, refused: 1 });
      }
    }
  }), 300_000);
});

describe('GST-327 gbrain repair secret-spans: resume and refusals', () => {
  test('an apply stopped by --limit resumes in page-id order and finishes; colliding timeline rows and ontology values refuse their page', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { engine } = repoLess[0]!;
    const AWS2 = 'AKIA' + 'EXAMPLENOTREAL01';
    // Imported first, so its id is lower although its slug sorts last.
    await importFromContent(engine, 'notes/z-old-example', `---\ntype: note\ntitle: Old\n---\n\nOld key ${AWS}.\n`, { noEmbed: true, sourceId: 'default' });
    await importFromContent(engine, 'notes/a-new-example', `---\ntype: note\ntitle: New\n---\n\nNew key ${AWS2}.\n`, { noEmbed: true, sourceId: 'default' });
    await importFromContent(engine, 'notes/dup-example', '---\ntype: note\ntitle: Dup\n---\n\nNo key in the body.\n', { noEmbed: true, sourceId: 'default' });
    await importFromContent(engine, 'notes/value-example', '---\ntype: note\ntitle: Value\n---\n\nNo key in the body.\n', { noEmbed: true, sourceId: 'default' });
    const dup = await pageRow(engine, 'notes/dup-example');
    await engine.executeRaw("INSERT INTO timeline_entries(page_id,date,source,summary,detail) VALUES ($1,'2024-05-01','import',$2,''),($1,'2024-05-01','import',$3,'')",
      [dup.id, `Rotated ${AWS}`, `Rotated ${AWS2}`]);
    await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,value,source,kind) VALUES ('default','notes/value-example','Credential on file',$1,'test','fact')`, [AWS]);
    const scope = await resolveRepairScope(engine, 'default');
    const slugs = ['notes/a-new-example', 'notes/z-old-example', 'notes/dup-example', 'notes/value-example'];
    const timelineBefore = await engine.executeRaw('SELECT id,summary FROM timeline_entries WHERE page_id=$1 ORDER BY id', [dup.id]);

    const preview = await (await repairRunner(engine, { apply: false, logger, noEmbed: true })).run('secret-spans', scope, { explicit: true, sourceFlag: 'default', slugs });
    expect(preview.listing!.map(entry => [entry.class, entry.item.split(' ')[0], entry.detail?.split(':')[0]])).toEqual([
      ['redact', 'default:notes/a-new-example', '1 span(s) in 1 field(s)'], ['refused', 'default:notes/dup-example', 'timeline_rows_collide'],
      ['refused', 'default:notes/value-example', 'fact_value_unsupported'], ['redact', 'default:notes/z-old-example', '1 span(s) in 1 field(s)']]);
    const apply = (limit?: number) => repairRunner(engine, { apply: true, logger, noEmbed: true })
      .then(runner => runner.run('secret-spans', scope, { explicit: true, sourceFlag: 'default', slugs, expect: preview.preview_hash, ...(limit ? { limit } : {}) }));
    const first = await apply(1);
    expect(first.applied).toBe(1);
    expect((await pageRow(engine, 'notes/z-old-example')).compiled_truth).not.toContain(AWS);
    const rest = await apply();
    expect(rest.applied).toBe(1);
    expect(rest.complete).toBe(true);
    expect((await pageRow(engine, 'notes/a-new-example')).compiled_truth).not.toContain(AWS2);
    expect(await engine.executeRaw('SELECT id,summary FROM timeline_entries WHERE page_id=$1 ORDER BY id', [dup.id])).toEqual(timelineBefore);
    expect(await engine.executeRaw("SELECT value FROM facts WHERE entity_slug='notes/value-example'")).toEqual([{ value: AWS }]);
  }), 120_000);
});

for (const backend of testBackends()) describe(`GST-327 gbrain repair secret-spans on a managed brain (${backend})`, () => {
  test('a held page is redacted in the database; its file, its hold and Git stay as they are', () => managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'notes/held-example';
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, source_id: 'default', request_id: randomUUID(),
      content: `---\ntype: note\ntitle: Held Example\n---\n\nThe old key ${OPENAI} sits in this note.\n` } });
    await settleManagedGitEffects(engine);
    const page = await pageRow(engine, slug);
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    await writeGitHold(engine, { source_id: 'default', incarnation: source!.incarnation, path: `${slug}.md`, source_path: `${slug}.md`, slug,
      page_id: Number(page.id), code: 'preparation_stalled', message: 'Preparation exhausted its attempts.', upstream_version: null,
      observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: 1 } });
    const hold = () => engine.executeRaw('SELECT completed_keys FROM op_checkpoints WHERE op=$1', [GIT_HOLD_OP]);
    const holdBefore = await hold();
    expect(holdBefore).toHaveLength(1);
    const file = readFileSync(join(root, `${slug}.md`), 'utf8');
    const commits = () => execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    const commitsBefore = commits();
    const requests = () => engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests');
    const requestsBefore = await requests();

    const scope = await resolveRepairScope(engine, 'default');
    const preview = await (await repairRunner(engine, { apply: false, logger })).run('secret-spans', scope, { explicit: true, sourceFlag: 'default', slugs: [slug] });
    expect(preview.affected).toBe(1);
    const result = await (await repairRunner(engine, { apply: true, logger })).run('secret-spans', scope, { explicit: true, sourceFlag: 'default', slugs: [slug], expect: preview.preview_hash });
    expect(result.outcomes).toEqual({ redacted: 1 });
    expect(result.verification).toMatchObject({ residual_matches: 0 });

    const after = await pageRow(engine, slug);
    expect(after.compiled_truth).toBe(page.compiled_truth.replace(OPENAI, M('openai')));
    expect(after.revision).not.toBe(page.revision);
    expect(await hold()).toEqual(holdBefore);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(file);
    expect(commits()).toBe(commitsBefore);
    expect(await requests()).toEqual(requestsBefore);
  }, { setup: ({ root }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); },
    databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined }), 120_000);
});

describe('GST-327 gbrain repair secret-spans command line', () => {
  test('--rules is parsed, sorted and checked before anything runs, and belongs to secret-spans only', () => {
    expect(parseRepairArgs(['secret-spans', '--source', 'default', '--slug', 'notes/a', '--rules', 'openai, aws_access_key']).rules).toEqual(['aws_access_key', 'openai']);
    expect(() => parseRepairArgs(['secret-spans', '--source', 'default', '--slug', 'notes/a', '--rules', 'openai,not_a_rule'])).toThrow(/Unknown secret rule/);
    expect(() => parseRepairArgs(['timeline-order', '--rules', 'openai'])).toThrow(/--rules/);
  });
});
