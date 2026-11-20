/**
 * Companies that share an id link automatically (GST-3127, Garry's E1 to E3): each sync links the cross-source company
 * groups its changed pages belong to ('dedupe:auto' identity rows, database only), gbrain dedupe reconcile sweeps every
 * company, and a reject keeps the pair apart for good.
 *
 * 1. Protects: a clean company pair sharing a LinkedIn company page links on sync, with the home-source page canonical
 *    (else the oldest); people never link; same-name namesakes with different own-site domains or countries, names that
 *    differ, contact-only pairs and pages a person linked by hand stay unlinked; a reject removes the link at once and
 *    keeps the pair apart after a rename, a move to another source and a database rebuilt from git; a sweep planned
 *    before a page changed or a hand link writes nothing; confirm takes an automatic group over; a group left with one
 *    page is removed; decisions recorded before fingerprints get them from the next sync; on a brain that keeps
 *    decisions in git, an owner-only page is never linked and a host without the checkout does not sweep.
 * 2. Fails when: a wrong pair links, a rejected pair links again, or a stale sweep writes a link.
 * 3. Real seams: both engines (Postgres with DATABASE_URL), real git repositories, performSync, the CLI module.
 *    Made-up names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { hasPendingMigrations } from '../src/core/migrate-pending.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { performSync } from '../src/commands/sync.ts';
import { confirmedCoMembers, linkEntityIdentity } from '../src/core/entity-identity.ts';
import { autoLinkCompanies } from '../src/core/entities/company-auto-link.ts';
import { decisionId, IDENTITY_DIR, projectIdentityDecisions, identityHome, syncIdentityDecisions } from '../src/core/entities/identity-decisions.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

for (const backend of testBackends()) describe(backend, () => {
let engine: BrainEngine;
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
let clone: { close: () => Promise<void> } | undefined;
beforeAll(async () => {
  if (backend === 'postgres') { template = await persistencePostgresTemplate(requirePostgresTestDatabase()); return; }
  const pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  await hasPendingMigrations(pglite);
  engine = pglite;
}, 120_000);
afterAll(async () => {
  if (backend === 'postgres') { await clone?.close(); await template?.dispose(); return; }
  await engine.disconnect();
});
beforeEach(async () => {
  if (backend === 'postgres') {
    await clone?.close();
    const c = await template!.clone();
    engine = c.engine; clone = c;
    await hasPendingMigrations(engine);
  } else {
    await resetPgliteState(engine as PGLiteEngine);
  }
  __resetPrivateVisibilityCacheForTests();
  for (const id of ['source-b', 'source-c']) await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('${id}', '${id}') ON CONFLICT DO NOTHING`);
}, 60_000);

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (slug: string, type: 'company' | 'person', title: string, frontmatter: Record<string, unknown>, sourceId: string) =>
  engine.putPage(slug, { type, title, compiled_truth: `${title}.`, timeline: '', frontmatter } as never, { sourceId });
const company = (sourceId: string, fm: Record<string, unknown> = {}, title = 'Acme Example', slug = 'companies/acme-example') =>
  put(slug, 'company', title, { linkedin: 'https://www.linkedin.com/company/acme-example/', website: 'https://acme-example.com', ...fm }, sourceId);
const identities = () => engine.executeRaw<{ entity_id: string; source_id: string; slug: string; established_by: string; canonical: boolean }>(
  'SELECT ei.entity_id, ei.source_id, p.slug, ei.established_by, ei.canonical FROM entity_identities ei JOIN pages p ON p.id = ei.page_id ORDER BY ei.source_id, p.slug');
const sweepAfterSync = (sourceId: string, ...slugs: string[]) => syncIdentityDecisions(engine, sourceId, undefined, slugs);
async function cli(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runDedupe(engine, args); } finally { spy.mockRestore(); }
  return lines.join('\n');
}
const previewMembers = async () => (JSON.parse(await cli(['--preview', '--json'])).groups as Array<{ members: Array<{ source_id: string; slug: string }> }>)
  .map(g => g.members.map(m => `${m.source_id}:${m.slug}`).join(' '));
const opCtx = (overrides: Partial<OperationContext> = {}) => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, ...overrides,
} as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;
const pageRef = async (sourceId: string, slug: string) => (await engine.executeRaw<{ id: number; generation: string }>(
  'SELECT id, generation::text AS generation FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]))[0]!;

describe('without a repository', () => {
  test('a sync links two companies that share a LinkedIn company page and a name; the home-source page is canonical; people never link', async () => {
    await company('default');
    await company('source-b', { linkedin: 'linkedin.com/company/acme-example', website: 'acme-example.com' });
    await put('people/alice-example', 'person', 'Alice Example', { linkedin: 'https://www.linkedin.com/in/alice-example/' }, 'default');
    await put('people/alice-example', 'person', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example' }, 'source-b');
    await sweepAfterSync('source-b', 'companies/acme-example', 'people/alice-example');
    const rows = await identities();
    const id = `dedupe-auto/${decisionId([{ source_id: 'default', slug: 'companies/acme-example' }, { source_id: 'source-b', slug: 'companies/acme-example' }])}`;
    expect(rows).toEqual([
      { entity_id: id, source_id: 'default', slug: 'companies/acme-example', established_by: 'dedupe:auto', canonical: true },
      { entity_id: id, source_id: 'source-b', slug: 'companies/acme-example', established_by: 'dedupe:auto', canonical: false },
    ]);
    expect((await confirmedCoMembers(engine, 'source-b', 'companies/acme-example')).map(m => m.source_id)).toEqual(['default']);
    await sweepAfterSync('source-b', 'companies/acme-example');
    expect(await identities()).toEqual(rows);
  });

  test('namesakes with different own-site domains or countries, names that differ and contact-only pairs stay unlinked', async () => {
    await company('default', { website: 'https://acme-example.com' });
    await company('source-b', { website: 'https://acme-example.co.uk' });
    await company('default', { linkedin: 'https://www.linkedin.com/company/velfield-example/', website: 'velfield-example.com', country: 'US' }, 'Velfield Example', 'companies/velfield-example');
    await company('source-b', { linkedin: 'https://www.linkedin.com/company/velfield-example/', website: 'velfield-example.com', country: 'DE' }, 'Velfield Example', 'companies/velfield-example');
    await put('companies/frelmont', 'company', 'Frelmont', { website: 'https://frelmont-example.com' }, 'default');
    await put('companies/frelmont-labs', 'company', 'Frelmont Labs', { website: 'https://frelmont-example.com' }, 'source-b');
    await put('companies/iselwood', 'company', 'Iselwood Example', { website: 'iselwood-example.com', email: 'hello@iselwood-example.com' }, 'default');
    await put('companies/iselwood', 'company', 'Iselwood Example', { website: 'iselwood-example.com', email: 'hello@iselwood-example.com' }, 'source-b');
    expect((await autoLinkCompanies(engine)).linked).toBe(0);
    expect(await identities()).toEqual([]);
  });

  test('a company whose only shared domain is a page on another site does not link on it', async () => {
    await put('companies/orbin', 'company', 'Orbin Example', { github: 'orbin-example', website: 'https://github.com/orbin-example' }, 'default');
    await put('companies/orbin', 'company', 'Orbin Example', { github: 'orbin-example', website: 'https://github.com/orbin-example' }, 'source-b');
    expect((await autoLinkCompanies(engine)).linked).toBe(0);
    await put('companies/orbin', 'company', 'Orbin Example', { github: 'orbin-example', website: 'https://orbin-example.com/' }, 'default');
    await put('companies/orbin', 'company', 'Orbin Example', { github: 'orbin-example', website: 'orbin-example.com' }, 'source-b');
    expect((await autoLinkCompanies(engine)).linked).toBe(1);
  });

  test('a reject removes the link at once and keeps the pair apart after a rename and after a move to another source', async () => {
    await company('default');
    await company('source-b');
    await sweepAfterSync('source-b', 'companies/acme-example');
    const [row] = await identities();
    expect(await cli(['reject', row!.entity_id])).toContain('as different people or companies');
    expect(await identities()).toEqual([]);
    const [decision] = await engine.executeRaw<{ evidence: unknown }>('SELECT evidence FROM entity_identity_reviews');
    expect((typeof decision!.evidence === 'string' ? JSON.parse(decision!.evidence) : decision!.evidence)).toHaveLength(2);
    await engine.deletePage('companies/acme-example', { sourceId: 'source-b' });
    await company('source-b', {}, 'Acme Example', 'companies/acme-example-inc');
    await sweepAfterSync('source-b', 'companies/acme-example-inc');
    await engine.deletePage('companies/acme-example-inc', { sourceId: 'source-b' });
    await company('source-c');
    await sweepAfterSync('source-c', 'companies/acme-example');
    expect((await autoLinkCompanies(engine)).linked).toBe(0);
    expect(await identities()).toEqual([]);
    expect(await previewMembers()).toEqual([]);
  });

  test('a sweep planned before a page changed, or before a hand link, writes nothing', async () => {
    await company('default');
    await company('source-b');
    const a = await pageRef('default', 'companies/acme-example');
    const b = await pageRef('source-b', 'companies/acme-example');
    const plan = { entity_id: 'dedupe-auto/plan', canonical_page_id: a.id, members: [
      { source_id: 'default', page_id: a.id, generation: Number(a.generation) }, { source_id: 'source-b', page_id: b.id, generation: Number(b.generation) }] };
    const read = await engine.listIdentityDecisions();
    await company('source-b', { founded: 2001 });
    expect((await engine.applyIdentityDecisions({ expectRevision: read.revision, auto: { link: [plan], unlink: [] } })).auto).toEqual({ linked: 0, unlinked: 0, skipped: 1 });
    const fresh = await pageRef('source-b', 'companies/acme-example');
    plan.members[1]!.generation = Number(fresh.generation);
    await linkEntityIdentity(engine, { entityId: 'acme-by-hand', slug: 'companies/acme-example', sourceId: 'source-b', canonical: true });
    expect((await engine.applyIdentityDecisions({ expectRevision: read.revision, auto: { link: [plan], unlink: [] } })).auto?.skipped).toBe(1);
    await sweepAfterSync('source-b', 'companies/acme-example');
    expect((await identities()).map(r => [r.source_id, r.established_by])).toEqual([['source-b', 'manual']]);
    await cli(['reject', JSON.parse(await cli(['--preview', '--json'])).groups[0].id]);
    const stale = await engine.applyIdentityDecisions({ expectRevision: read.revision, auto: { link: [plan], unlink: [] } });
    expect(stale.stale).toBe(true);
  });

  test('confirm takes an automatic group over, and a group left with one page is removed', async () => {
    await company('default');
    await company('source-b');
    await company('default', { linkedin: 'linkedin.com/company/velfield-example', website: 'velfield-example.com' }, 'Velfield Example', 'companies/velfield-example');
    await company('source-c', { linkedin: 'linkedin.com/company/velfield-example', website: 'velfield-example.com' }, 'Velfield Example', 'companies/velfield-example');
    expect((await autoLinkCompanies(engine)).linked).toBe(2);
    const acme = JSON.parse(await cli(['--preview', '--json'])).groups.find((g: { members: Array<{ slug: string }> }) => g.members[0]!.slug === 'companies/acme-example').id;
    expect(await cli(['confirm', acme])).toContain('Confirmed');
    await engine.deletePage('companies/velfield-example', { sourceId: 'source-c' });
    await sweepAfterSync('source-c', 'companies/velfield-example');
    expect((await identities()).map(r => [r.source_id, r.slug, r.established_by])).toEqual([
      ['default', 'companies/acme-example', 'dedupe:confirm'], ['source-b', 'companies/acme-example', 'dedupe:confirm']]);
  });

  test('outside the home source the oldest page is canonical, never the longest', async () => {
    await company('source-b');
    await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'Acme Example. '.repeat(200), timeline: '',
      frontmatter: { linkedin: 'linkedin.com/company/acme-example', website: 'acme-example.com' } } as never, { sourceId: 'source-c' });
    await engine.executeRaw("UPDATE pages SET created_at = now() - interval '30 days' WHERE source_id = 'source-b' AND slug = 'companies/acme-example'");
    await autoLinkCompanies(engine);
    expect((await identities()).map(r => [r.source_id, r.canonical])).toEqual([['source-b', true], ['source-c', false]]);
  });

  test('a "different" decision recorded before fingerprints were kept gets them from the next sync', async () => {
    await company('default');
    await company('source-b');
    const members = [{ source_id: 'default', slug: 'companies/acme-example' }, { source_id: 'source-b', slug: 'companies/acme-example' }];
    await engine.applyIdentityDecisions({ upsert: [{ decision_id: decisionId(members), verdict: 'different', members, group_id: null, entity_id: null, canonical: null,
      decided_by: 'owner', origin: 'database', home_source_id: null, git_blob: null }] });
    await syncIdentityDecisions(engine, 'default');
    const [d] = (await engine.listIdentityDecisions()).decisions;
    expect(d!.evidence).toHaveLength(2);
  });

  test('a page that carries the same LinkedIn or GitHub id behind a query string or fragment keeps the pair unlinked on sync, as on reconcile', async () => {
    await company('default');
    await company('source-b');
    await company('source-c', { linkedin: 'https://www.linkedin.com/company/acme-example?originalSubdomain=uk', website: 'acme-example.co.uk' }, 'Acme Example UK Holdings', 'companies/acme-example-uk');
    await put('companies/orbin', 'company', 'Orbin Example', { github: 'orbin-example', website: 'https://orbin-example.com/' }, 'default');
    await put('companies/orbin', 'company', 'Orbin Example', { github: 'orbin-example', website: 'orbin-example.com' }, 'source-b');
    await put('companies/orbin-labs', 'company', 'Orbin Labs', { github: 'https://github.com/orbin-example#readme' }, 'source-c');
    await sweepAfterSync('source-b', 'companies/acme-example', 'companies/orbin');
    expect(await identities()).toEqual([]);
    expect((await autoLinkCompanies(engine)).linked).toBe(0);
  });

  test('a person page that carries the company LinkedIn page keeps the pair unlinked, as the preview counts it', async () => {
    await company('default');
    await company('source-b');
    await put('people/bob-example', 'person', 'Bob Example', { linkedin: 'https://www.linkedin.com/company/acme-example/' }, 'source-c');
    await sweepAfterSync('source-b', 'companies/acme-example');
    expect(await identities()).toEqual([]);
    expect((await autoLinkCompanies(engine)).linked).toBe(0);
  });

  test('rejecting a pair of pages with no strong id keeps only that pair apart, never another pair with the same name', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-d', 'source-d') ON CONFLICT DO NOTHING");
    await put('people/sam-example', 'person', 'Sam Example', { email: 'sam@example.com' }, 'default');
    await put('people/sam-example', 'person', 'Sam Example', { email: 'sam@example.com' }, 'source-b');
    await put('people/sam-example', 'person', 'Sam Example', { phone: '+1 415 555 0199' }, 'source-c');
    await put('people/sam-example', 'person', 'Sam Example', { phone: '+1 415 555 0199' }, 'source-d');
    const groups = JSON.parse(await cli(['--preview', '--json'])).groups as Array<{ id: string; members: Array<{ source_id: string }> }>;
    await cli(['reject', groups.find(g => g.members.some(m => m.source_id === 'default'))!.id]);
    expect(await previewMembers()).toEqual(['source-c:people/sam-example source-d:people/sam-example']);
  });

  test('a page the sync linked is moved by hand into another group, but not unlinked by hand; reject by the dedupe/ group id removes the link', async () => {
    await company('default');
    await company('source-b');
    await company('default', { linkedin: 'linkedin.com/company/velfield-example', website: 'velfield-example.com' }, 'Velfield Example', 'companies/velfield-example');
    await company('source-c', { linkedin: 'linkedin.com/company/velfield-example', website: 'velfield-example.com' }, 'Velfield Example', 'companies/velfield-example');
    expect((await autoLinkCompanies(engine)).linked).toBe(2);
    const acme = (await identities()).find(r => r.slug === 'companies/acme-example')!.entity_id;
    await expect(op('entity_identity_unlink').handler(opCtx(), { entity_id: acme, slug: 'companies/acme-example', source_id: 'source-b' }))
      .rejects.toMatchObject({ code: 'identity_link_owned_by_dedupe' });
    await op('entity_identity_link').handler(opCtx(), { entity_id: 'acme-by-hand', slug: 'companies/acme-example', source_id: 'source-b', canonical: true });
    await sweepAfterSync('source-b', 'companies/acme-example');
    expect((await identities()).filter(r => r.slug === 'companies/acme-example').map(r => [r.source_id, r.entity_id, r.established_by]))
      .toEqual([['source-b', 'acme-by-hand', 'manual']]);
    const velfield = JSON.parse(await cli(['--preview', '--json'])).groups.find((g: { members: Array<{ slug: string }> }) => g.members[0]!.slug === 'companies/velfield-example').id;
    expect(await cli(['reject', velfield])).toContain('as different people or companies');
    expect((await identities()).filter(r => r.established_by === 'dedupe:auto')).toEqual([]);
  });

  test('rank_entities counts a company the sync linked once', async () => {
    await company('default');
    await company('source-b');
    await engine.putPage('notes/n1', { type: 'note', title: 'n1', compiled_truth: 'Note.', timeline: '', frontmatter: {} } as never, { sourceId: 'source-b' });
    await engine.addLink('notes/n1', 'companies/acme-example', '', 'references', 'manual', undefined, undefined, { fromSourceId: 'source-b', toSourceId: 'source-b' });
    await autoLinkCompanies(engine);
    const ranked = ((await op('rank_entities').handler(opCtx(), { types: ['company'] })) as { entities: Array<{ slug: string; source_id: string; inbound: number }> })
      .entities.map(e => [e.source_id, e.slug, e.inbound]);
    expect(ranked).toEqual([['default', 'companies/acme-example', 1]]);
  });

  test('a carrier whose LinkedIn page ends in its own prefix and a slash keeps the pair unlinked on sync', async () => {
    await company('default', { linkedin: 'linkedin.com/company/trident-company', website: 'trident-example.com' }, 'Trident Company', 'companies/trident');
    await company('source-b', { linkedin: 'linkedin.com/company/trident-company', website: 'trident-example.com' }, 'Trident Company', 'companies/trident');
    await company('source-c', { linkedin: 'https://www.linkedin.com/company/trident-company/', website: 'trident-holdings.example' }, 'Trident Holdings', 'companies/trident-holdings');
    await sweepAfterSync('source-b', 'companies/trident');
    expect(await identities()).toEqual([]);
  });

  test('a page synced later that carries the same id removes the automatic link, and deleting the main page relinks the rest with a new main page', async () => {
    await company('default');
    await company('source-b');
    await sweepAfterSync('source-b', 'companies/acme-example');
    expect(await identities()).toHaveLength(2);
    await company('source-c', { website: 'acme-holdings.example' }, 'Acme Example Holdings', 'companies/acme-holdings');
    await sweepAfterSync('source-c', 'companies/acme-holdings');
    expect(await identities()).toEqual([]);
    await engine.deletePage('companies/acme-holdings', { sourceId: 'source-c' });
    await company('source-c');
    await autoLinkCompanies(engine);
    expect((await identities()).map(r => [r.source_id, r.canonical])).toEqual([['default', true], ['source-b', false], ['source-c', false]]);
    await engine.deletePage('companies/acme-example', { sourceId: 'default' });
    await sweepAfterSync('default', 'companies/acme-example');
    const rows = await identities();
    expect(rows.map(r => [r.source_id, r.established_by])).toEqual([['source-b', 'dedupe:auto'], ['source-c', 'dedupe:auto']]);
    expect(rows.filter(r => r.canonical)).toHaveLength(1);
  });

  test('a folder source without git links the companies each sync brings in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'company-auto-link-folder-'));
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'start.md'), '---\ntype: note\ntitle: Start\n---\nStart.\n');
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'source-c'", [dir]);
    await company('source-b');
    const sync = () => performSync(engine, { sourceId: 'source-c', noPull: true, noEmbed: true, concurrency: 1 });
    await sync();
    mkdirSync(join(dir, 'companies'), { recursive: true });
    writeFileSync(join(dir, 'companies', 'acme-example.md'), '---\ntype: company\ntitle: Acme Example\nlinkedin: https://www.linkedin.com/company/acme-example/\nwebsite: https://acme-example.com\n---\nAcme Example.\n');
    const r = await sync();
    expect(r.status).not.toBe('first_sync');
    expect((await identities()).map(x => [x.source_id, x.established_by])).toEqual([['source-b', 'dedupe:auto'], ['source-c', 'dedupe:auto']]);
  });
});

describe('with a repository', () => {
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'company-auto-link-'));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    mkdirSync(join(root, 'companies'), { recursive: true });
    writeFileSync(join(root, 'companies', 'acme-example.md'), '---\ntype: company\ntitle: Acme Example\nlinkedin: https://www.linkedin.com/company/acme-example/\nwebsite: https://acme-example.com\n---\nAcme Example.\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'pages');
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
    await company('source-b');
  });
  const syncHome = () => performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true, concurrency: 1 });

  test('sync links the pair; the reject is committed with its fingerprints, so a database rebuilt from git keeps the pair apart after a rename', async () => {
    await syncHome();
    const [row] = await identities();
    expect(row?.established_by).toBe('dedupe:auto');
    await cli(['reject', row!.entity_id]);
    const id = decisionId([{ source_id: 'default', slug: 'companies/acme-example' }, { source_id: 'source-b', slug: 'companies/acme-example' }]);
    expect(git(root, 'show', `HEAD:${IDENTITY_DIR}/${id}.md`)).toMatch(/evidence:\n  - [0-9a-f]{32}\n  - [0-9a-f]{32}\n/);
    await engine.executeRaw('DELETE FROM entity_identity_reviews');
    await engine.deletePage('companies/acme-example', { sourceId: 'source-b' });
    await company('source-b', {}, 'Acme Example', 'companies/acme-example-inc');
    await projectIdentityDecisions(engine, (await identityHome(engine))!);
    expect((await autoLinkCompanies(engine)).linked).toBe(0);
    expect(await identities()).toEqual([]);
  });

  test('a page in an owner-only source is never linked, and a host without the checkout does not sweep', async () => {
    await engine.executeRaw("UPDATE sources SET config = '{\"owner_only\": true}'::jsonb WHERE id = 'source-b'");
    await syncHome();
    expect(await identities()).toEqual([]);
    await engine.executeRaw("UPDATE sources SET config = '{}'::jsonb WHERE id = 'source-b'");
    await company('source-c', {}, 'Bramble Example', 'companies/bramble-example');
    await cli(['reject', JSON.parse(await cli(['--preview', '--json'])).groups[0].id]);
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [mkdtempSync(join(tmpdir(), 'no-checkout-'))]);
    expect((await autoLinkCompanies(engine)).skipped_sweep).toBe('no_checkout');
    expect(await identities()).toEqual([]);
  });
});
});
