/**
 * Dedupe v2 follow-up (GST-3642): C7 collapse of two person pages in one source with the same name and a shared id, on a
 * repo-less PGLite brain (through the page door) and on a source with a git repository (one commit per collapse), with
 * preview, undo, reject, --off, the doctor line and the weekly sample; and the git-backed apply path of automatic links.
 * Placeholder people only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hasPendingMigrations } from '../src/core/migrate-pending.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { performSync } from '../src/commands/sync.ts';
import { setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import { dedupeAutoLinksEntry } from '../src/commands/doctor/checks/entity-duplicates.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { applyAutoLinks, planAutoLinks } from '../src/core/entities/evidence/auto.ts';
import { decisionId, IDENTITY_DIR, recordDecisions } from '../src/core/entities/identity-decisions.ts';
import { listCollapses } from '../src/core/entities/evidence/collapse.ts';
import * as mutations from '../src/core/persistence/page-mutations.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function harness(get: () => BrainEngine) {
  const person = (slug: string, title: string, frontmatter: Record<string, unknown> = {}, sourceId = 'default') =>
    get().putPage(slug, { type: 'person', title, compiled_truth: `${title} notes.`, timeline: '', frontmatter } as never, { sourceId } as never);
  async function dedupe(args: string[]): Promise<string> {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try { await runDedupe(get(), args); } finally { spy.mockRestore(); setCliExitVerdict(0); }
    return lines.join('\n');
  }
  const json = async (args: string[]) => JSON.parse(await dedupe([...args, '--json']));
  const fm = async (slug: string, sourceId = 'default') => ((await get().getPage(slug, { sourceId }))?.frontmatter ?? {}) as Record<string, unknown>;
  const doctorLine = async () => {
    const ctx = { engine: get(), orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as unknown as DoctorContext;
    const [c] = await dedupeAutoLinksEntry.run(ctx) as Array<{ name: string; status: string; message: string; details: { links: number } }>;
    return c!;
  };
  return { person, dedupe, json, fm, doctorLine };
}

for (const backend of testBackends()) describe(`C7 collapse without a repository (${backend})`, () => {
  let home: string;
  let engine: BrainEngine;
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
  let clone: { close: () => Promise<void> } | undefined;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-dedupe-collapse-'));
    if (backend === 'postgres') {
      template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      const c = await template.clone();
      engine = c.engine; clone = c;
      await hasPendingMigrations(engine);
    } else {
      engine = await connectTemplateBrain(join(home, 'database'));
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }, 120_000);
  afterAll(async () => {
    if (backend === 'postgres') { await clone?.close(); await template?.dispose(); } else await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });
  const h = harness(() => engine);
  let collapse = '';

  test('preview lists one collapse per same-source pair with a shared id and changes nothing; a family pair is held', async () => {
    await h.person('people/robert-example', 'Robert Example', { linkedin: 'in/robert-ex', aliases: ['Rob E'] });
    await h.person('people/bob-example', 'Bob Example', { linkedin: 'https://linkedin.com/in/robert-ex', company: 'Acme Example' });
    await h.person('people/hana-example', 'Hana Example', { email: 'hana@example.invalid', relationship: 'sister' });
    await h.person('people/hana-example-2', 'Hana Example', { email: 'hana@example.invalid' });
    const plan = await h.json(['auto']);
    expect(plan.switches).toEqual({ C2: 'on', C7: 'on' });
    expect(plan.collapses).toHaveLength(1);
    const c = plan.collapses[0];
    expect(c).toMatchObject({ class: 'C7', source_id: 'default', canonical: 'people/robert-example', retired: 'people/bob-example', aliases: ['Bob Example'], store: 'database' });
    collapse = c.collapse;
    expect(collapse).toBe(decisionId([{ source_id: 'default', slug: 'people/robert-example' }, { source_id: 'default', slug: 'people/bob-example' }]));
    expect(plan.collapses.some((x: any) => x.retired.startsWith('people/hana'))).toBe(false);
    expect(await h.fm('people/bob-example')).not.toHaveProperty('merged_into');
  });

  test('--apply points the newer page at the older one, adds its name as an alias, keeps the body and a version before the edit', async () => {
    const body = (await engine.getPage('people/bob-example'))!.compiled_truth;
    const out = await h.json(['auto', '--apply']);
    expect(out.collapsed).toEqual([expect.objectContaining({ collapse, status: 'collapsed', store: 'database' })]);
    const gone = await h.fm('people/bob-example');
    expect(gone.merged_into).toBe('people/robert-example');
    expect(gone.dedupe_collapse).toMatchObject({ class: 'C7', aliases: ['Bob Example'] });
    expect(gone.company).toBe('Acme Example');
    expect((await engine.getPage('people/bob-example'))!.compiled_truth).toBe(body);
    expect((await h.fm('people/robert-example')).aliases).toEqual(['Rob E', 'Bob Example']);
    const versions = await engine.getVersions('people/bob-example', { sourceId: 'default' } as never) as unknown as Array<{ frontmatter: Record<string, unknown> }>;
    expect(versions.some(v => v.frontmatter && !('merged_into' in v.frontmatter))).toBe(true);
    expect((await h.json(['auto'])).collapses).toEqual([]);
  });

  test('the doctor line leads with reject, and the weekly sample reads the collapse', async () => {
    const line = await h.doctorLine();
    expect(line).toMatchObject({ name: 'dedupe_auto_links', details: { links: 1 } });
    expect(line.message).toContain(`C7 1 (a wrong one for good: gbrain dedupe reject <collapse id>; undo: gbrain dedupe undo ${collapse}; all of them: gbrain dedupe auto --off C7)`);
    const sample = await h.json(['sample', '--class', 'C7', '--since', '7d']);
    expect(sample).toMatchObject({ class: 'C7', total: 1, corrected: 0 });
    expect(sample.links[0]).toMatchObject({ decision: collapse, reject: `gbrain dedupe reject ${collapse}` });
  });

  test('undo removes exactly what the collapse added, and the pair is proposed again', async () => {
    const out = await h.json(['undo', collapse]);
    expect(out.collapses).toEqual([expect.objectContaining({ collapse, status: 'undone' })]);
    const gone = await h.fm('people/bob-example');
    expect(gone).not.toHaveProperty('merged_into');
    expect(gone).not.toHaveProperty('dedupe_collapse');
    expect((await h.fm('people/robert-example')).aliases).toEqual(['Rob E']);
    expect((await h.json(['auto'])).collapses.map((c: any) => c.collapse)).toEqual([collapse]);
  });

  test('a stale plan writes nothing over a page that changed since it was read', async () => {
    const plan = await planAutoLinks(engine);
    await h.person('people/bob-example', 'Bob Example', { linkedin: 'in/robert-ex', merged_into: 'people/someone-else-example' });
    const r = await applyAutoLinks(engine, plan);
    expect(r.collapses).toEqual([expect.objectContaining({ collapse, status: 'skipped', reason: 'changed' })]);
    expect((await h.fm('people/bob-example')).merged_into).toBe('people/someone-else-example');
    expect((await h.fm('people/robert-example')).aliases).toEqual(['Rob E']);
    await h.person('people/bob-example', 'Bob Example', { linkedin: 'https://linkedin.com/in/robert-ex', company: 'Acme Example' });
  });

  test('a reject, a distinct_from or an --off that lands after the plan is never written over by a collapse', async () => {
    const members = [{ source_id: 'default', slug: 'people/bob-example' }, { source_id: 'default', slug: 'people/robert-example' }];
    let plan = await planAutoLinks(engine);
    await recordDecisions(engine, [{ verdict: 'different', members, group_id: null, entity_id: null, canonical: null, decided_by: 'owner' }], 'test: reject the pair');
    expect((await applyAutoLinks(engine, plan)).collapses).toEqual([expect.objectContaining({ collapse, status: 'skipped', reason: 'changed' })]);
    expect(await h.fm('people/bob-example')).not.toHaveProperty('merged_into');
    await h.dedupe(['undo', collapse]);
    plan = await planAutoLinks(engine);
    await h.person('people/bob-example', 'Bob Example', { linkedin: 'https://linkedin.com/in/robert-ex', company: 'Acme Example', distinct_from: ['people/robert-example'] });
    expect((await applyAutoLinks(engine, plan)).collapses).toEqual([expect.objectContaining({ status: 'skipped', reason: 'changed' })]);
    await h.person('people/bob-example', 'Bob Example', { linkedin: 'https://linkedin.com/in/robert-ex', company: 'Acme Example' });
    plan = await planAutoLinks(engine);
    await h.dedupe(['auto', '--off', 'C7']);
    expect((await applyAutoLinks(engine, plan)).collapses).toEqual([expect.objectContaining({ status: 'skipped', reason: 'changed' })]);
    expect(await h.fm('people/bob-example')).not.toHaveProperty('merged_into');
    await h.dedupe(['auto', '--on', 'C7']);
  });

  test('a kept page that fails to take its aliases takes the collapse back; an undo that cannot reach the kept page says so', async () => {
    const real = mutations.submitPageMutation;
    const onKept = (error: Error) => spyOn(mutations, 'submitPageMutation').mockImplementation(async (ctx, req) =>
      ((req.params as { slug?: string }).slug === 'people/robert-example' ? Promise.reject(error) : real(ctx, req)));
    const spy = onKept(new Error('injected'));
    let failed: Awaited<ReturnType<typeof applyAutoLinks>>;
    try { failed = await applyAutoLinks(engine, await planAutoLinks(engine)); } finally { spy.mockRestore(); }
    expect(failed.collapses).toEqual([expect.objectContaining({ collapse, status: 'skipped', reason: 'failed', note: expect.stringContaining('injected') })]);
    expect(await h.fm('people/bob-example')).not.toHaveProperty('merged_into');
    expect((await h.fm('people/robert-example')).aliases).toEqual(['Rob E']);
    await applyAutoLinks(engine, await planAutoLinks(engine));
    const spy2 = onKept(new OperationError('revision_conflict', 'the page moved'));
    let undone: any;
    try { undone = await h.json(['undo', collapse]); } finally { spy2.mockRestore(); }
    expect(undone.collapses).toEqual([expect.objectContaining({ status: 'skipped', reason: 'changed', note: expect.stringContaining('Bob Example') })]);
    expect(await h.fm('people/bob-example')).not.toHaveProperty('merged_into');
    expect((await h.fm('people/robert-example')).aliases).toEqual(['Rob E', 'Bob Example']);
    await h.person('people/robert-example', 'Robert Example', { linkedin: 'in/robert-ex', aliases: ['Rob E'] });
  });

  test('reject <collapse id> takes the collapse back and keeps the pair apart; the weekly sample keeps it as corrected', async () => {
    await h.dedupe(['auto', '--apply']);
    expect((await h.fm('people/bob-example')).merged_into).toBe('people/robert-example');
    const out = await h.json(['reject', collapse]);
    expect(out.collapses).toEqual([expect.objectContaining({ status: 'undone' })]);
    expect(await h.fm('people/bob-example')).not.toHaveProperty('merged_into');
    const d = (await engine.listIdentityDecisions()).decisions.find(x => x.decision_id === collapse)!;
    expect(d).toMatchObject({ verdict: 'different', decided_by: 'owner:corrects:dedupe:auto:C7' });
    expect(d.evidence).toHaveLength(2);
    expect((await h.json(['auto'])).collapses).toEqual([]);
    const sample = await h.json(['sample', '--class', 'C7', '--since', '7d']);
    expect(sample).toMatchObject({ total: 1, corrected: 1 });
    expect(sample.links[0]).toMatchObject({ decision: collapse, corrected: true });
  });

  test('--off C7 takes back every collapse and stops the class; --on starts it again', async () => {
    await h.person('people/catherine-example', 'Catherine Example', { github: 'cathex' });
    await h.person('people/cathy-example', 'Cathy Example', { github: 'https://github.com/cathex' });
    const applied = await h.json(['auto', '--apply']);
    const id = applied.collapsed[0].collapse;
    expect((await h.fm('people/cathy-example')).merged_into).toBe('people/catherine-example');
    expect(await h.json(['auto', '--off', 'C7'])).toEqual({ class: 'C7', switch: 'off', removed: [id] });
    expect(await h.fm('people/cathy-example')).not.toHaveProperty('merged_into');
    expect(await h.json(['auto'])).toMatchObject({ switches: { C7: 'off' }, collapses: [] });
    await h.dedupe(['auto', '--on', 'C7']);
    expect((await h.json(['auto'])).collapses.map((c: any) => c.collapse)).toEqual([id]);
  });

  test('two ids that disagree veto a collapse even when a third id matches', async () => {
    await h.person('people/ida-example', 'Ida Example', { github: 'idaex', linkedin: 'in/ida-one' });
    await h.person('people/ida-example-2', 'Ida Example', { github: 'https://github.com/idaex', linkedin: 'in/ida-two' });
    expect((await h.json(['auto'])).collapses.some((c: any) => c.retired.startsWith('people/ida-example'))).toBe(false);
    for (const slug of ['people/ida-example', 'people/ida-example-2']) await engine.deletePage(slug, { sourceId: 'default' } as never);
  });

  test('a read-only source is set aside, and a collapse in a source made read-only afterwards is not undone through it', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('side-a', 'side-a', '{}'::jsonb) ON CONFLICT DO NOTHING");
    await h.person('people/jo-example', 'Jo Example', { github: 'joex' }, 'side-a');
    await h.person('people/jo-example-2', 'Jo Example', { github: 'https://github.com/joex' }, 'side-a');
    await h.dedupe(['auto', '--apply']);
    const jo = (await listCollapses(engine)).find(c => c.source_id === 'side-a')!;
    expect((await h.fm('people/jo-example-2', 'side-a')).merged_into).toBe('people/jo-example');
    await engine.executeRaw(`UPDATE sources SET config = '{"mirror_read_only": true}'::jsonb WHERE id = 'side-a'`);
    expect((await h.json(['undo', jo.collapse])).collapses).toEqual([expect.objectContaining({ status: 'skipped', reason: 'read_only_source' })]);
    expect((await h.fm('people/jo-example-2', 'side-a')).merged_into).toBe('people/jo-example');
    await engine.executeRaw(`UPDATE sources SET config = '{}'::jsonb WHERE id = 'side-a'`);
    await h.dedupe(['undo', jo.collapse]);
    await engine.executeRaw(`UPDATE sources SET config = '{"mirror_read_only": true}'::jsonb WHERE id = 'side-a'`);
    const plan = await h.json(['auto']);
    expect(plan.collapses.some((c: any) => c.source_id === 'side-a')).toBe(false);
    expect(plan.set_aside).toContainEqual(expect.objectContaining({ reason: 'read_only_source' }));
  });
});

describe('with a repository', () => {
  let engine: BrainEngine;
  let root: string;
  let dir: string;
  const files: Record<string, string> = {
    'people/dana-example.md': '---\ntype: person\ntitle: Dana Example\n# kept as written\ngithub: danaex\naliases: [D. Example]\n---\nDana Example notes.\n',
    'people/dee-example.md': '---\ntype: person\ntitle: Dana Example\ngithub: https://github.com/danaex\ncompany: Acme Example\n---\nDana notes, older copy.\n',
  };
  beforeAll(async () => {
    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    await hasPendingMigrations(pglite);
    engine = pglite;
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('people-b','people-b') ON CONFLICT DO NOTHING");
    dir = mkdtempSync(join(tmpdir(), 'gbrain-dedupe-collapse-git-'));
    root = join(dir, 'repo');
    mkdirSync(join(root, 'people'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'user.name', 'Test');
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    writeFileSync(join(root, 'people/eli-example.md'), '---\ntype: person\ntitle: Eli Example\nemail: eli@example.invalid\n---\nEli notes.\n');
    writeFileSync(join(root, 'people/fay-example.md'), '---\ntype: person\ntitle: Fay Example\nemail: fay@example.invalid\n---\nFay notes.\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'pages');
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
    await performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true, concurrency: 1 });
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });
  const h = harness(() => engine);

  test('a collapse is one commit that only adds lines, the database reads it back, and undo restores the files byte for byte', async () => {
    const plan = await h.json(['auto']);
    const c = plan.collapses.find((x: any) => x.source_id === 'default')!;
    expect(c).toMatchObject({ store: 'git' });
    const [retired, kept] = [`${c.retired}.md`, `${c.canonical}.md`];
    const commits = Number(git(root, 'rev-list', '--count', 'HEAD'));
    const out = await h.json(['auto', '--apply']);
    expect(out.collapsed).toEqual([expect.objectContaining({ collapse: c.collapse, status: 'collapsed', store: 'git' })]);
    expect(Number(git(root, 'rev-list', '--count', 'HEAD'))).toBe(commits + 1);
    expect(git(root, 'log', '-1', '--format=%B')).toContain(`Dedupe-Collapse: ${c.collapse}`);
    expect(git(root, 'status', '--porcelain')).toBe('');
    const diff = git(root, 'diff', 'HEAD~1', 'HEAD', '--unified=0', '--', retired);
    expect(diff.split('\n').filter(l => /^-[^-]/.test(l))).toEqual([]);
    expect(readFileSync(join(root, retired), 'utf8')).toContain(`merged_into: ${c.canonical}`);
    expect(readFileSync(join(root, retired), 'utf8').endsWith(files[retired]!.slice(files[retired]!.indexOf('\n---\n') + 1))).toBe(true);
    expect((await h.fm(c.retired)).merged_into).toBe(c.canonical);
    expect((await h.json(['auto'])).collapses).toEqual([]);
    const undone = await h.json(['undo', c.collapse]);
    expect(undone.collapses).toEqual([expect.objectContaining({ status: 'undone', store: 'git' })]);
    expect(Number(git(root, 'rev-list', '--count', 'HEAD'))).toBe(commits + 2);
    expect(readFileSync(join(root, retired), 'utf8')).toBe(files[retired]!);
    expect(c.aliases).toEqual(['D. Example']);
    expect(readFileSync(join(root, kept), 'utf8')).toBe(files[kept]!);
    expect(await h.fm(c.retired)).not.toHaveProperty('merged_into');
  });

  test('automatic links on a brain that keeps decisions in git: committed in one commit, a page that turned restricted after the scan is set aside, a concurrent reject is never written over', async () => {
    await h.person('contacts/eli-card', 'elicard', { email: 'eli@example.invalid' }, 'people-b');
    await h.person('contacts/fay-card', 'faycard', { email: 'fay@example.invalid' }, 'people-b');
    const real = engine.listRestrictedIdentityMembers.bind(engine);
    let reads = 0;
    const spy = spyOn(engine, 'listRestrictedIdentityMembers').mockImplementation(async members =>
      (reads++ === 0 ? real(members) : [...await real(members), ...members.filter(m => m.slug === 'contacts/fay-card')]));
    let plan: Awaited<ReturnType<typeof planAutoLinks>>;
    try { plan = await planAutoLinks(engine); } finally { spy.mockRestore(); }
    expect(plan.links.map(l => l.members.map(m => m.slug).sort())).toEqual([['contacts/eli-card', 'people/eli-example']]);
    expect(plan.set_aside).toContainEqual(expect.objectContaining({ reason: 'not_publishable', members: [{ source_id: 'default', slug: 'people/fay-example' }, { source_id: 'people-b', slug: 'contacts/fay-card' }] }));
    const link = plan.links[0]!;
    await recordDecisions(engine, [{ verdict: 'different', members: link.members, group_id: null, entity_id: null, canonical: null, decided_by: 'owner' }], 'test: reject the pair');
    const r = await applyAutoLinks(engine, plan);
    expect(r).toMatchObject({ linked: [], changed: [link.decision] });
    expect(git(root, 'show', `HEAD:${IDENTITY_DIR}/${link.decision}.md`)).toContain('verdict: different');
    await h.dedupe(['undo', link.decision]);
    const commits = Number(git(root, 'rev-list', '--count', 'HEAD'));
    const again = await applyAutoLinks(engine, await planAutoLinks(engine));
    expect(again.linked).toHaveLength(2);
    expect(again.linked).toContain(link.decision);
    expect(Number(git(root, 'rev-list', '--count', 'HEAD'))).toBe(commits + 1);
    expect(git(root, 'show', `HEAD:${IDENTITY_DIR}/${link.decision}.md`)).toContain('decided_by: dedupe:auto:C2');
  });

  test('--off removes a link committed to git that the database has not read yet', async () => {
    const id = decisionId([{ source_id: 'default', slug: 'people/eli-example' }, { source_id: 'people-b', slug: 'contacts/eli-card' }]);
    await h.dedupe(['undo', id]);
    writeFileSync(join(root, IDENTITY_DIR, `${id}.md`), `---\nverdict: same\nmembers:\n  - source_id: default\n    slug: people/eli-example\n  - source_id: people-b\n    slug: contacts/eli-card\nentity_id: person-${id}\ndecided_by: dedupe:auto:C2\ndecided_at: '2026-11-25T00:00:00.000Z'\n---\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'a link written by another host');
    expect((await engine.listIdentityDecisions()).decisions.some(d => d.decision_id === id)).toBe(false);
    const off = await h.json(['auto', '--off', 'C2']);
    expect(off.removed).toHaveLength(2);
    expect(off.removed).toContain(id);
    expect(() => git(root, 'show', `HEAD:${IDENTITY_DIR}/${id}.md`)).toThrow();
    await h.dedupe(['auto', '--on', 'C2']);
  });

  const extra: Record<string, string> = {
    'people/gus-example.md': '\uFEFF---\ntype: person\ntitle: Gus Example\ngithub: gusex\n---\nGus notes.\n',
    'people/gus-example-2.md': '---\ntype: person\ntitle: Gus Example\ngithub: https://github.com/gusex\n---\nGus, again.\n',
    'people/hal-example.md': '---\ntype: person\ntitle: Hal Example\ngithub: halex\n---\nHal notes.\n',
    'people/hal-example-2.md': '---\ntype: person\ntitle: Hal Example\ngithub: https://github.com/halex\n---\nHal, again.\n',
  };
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const planFor = async (slug: string) => (await planAutoLinks(engine)).collapses.filter(c => [c.retired, c.canonical].includes(slug));

  test('a file whose frontmatter opens with a byte-order mark is left alone, never given a second block', async () => {
    for (const [path, text] of Object.entries(extra)) writeFileSync(join(root, path), text);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'more pages');
    await performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true, concurrency: 1 });
    const [gus] = await planFor('people/gus-example');
    expect(gus).toBeDefined();
    const out = await applyAutoLinks(engine, { ...(await planAutoLinks(engine)), links: [], collapses: [gus!] });
    expect(out.collapses).toEqual([expect.objectContaining({ status: 'skipped', reason: 'frontmatter_not_editable', store: 'git' })]);
    expect(read('people/gus-example.md')).toBe(extra['people/gus-example.md']!);
    expect(read('people/gus-example-2.md')).toBe(extra['people/gus-example-2.md']!);
  });

  test('reject and --off of a collapse in git: the collapse taken back in a commit, the reject committed, --off restoring the files byte for byte', async () => {
    const danaOf = async () => (await listCollapses(engine)).filter(c => [c.retired, c.canonical].includes('people/dana-example'));
    if (!(await danaOf()).length) await applyAutoLinks(engine, { ...(await planAutoLinks(engine)), links: [], collapses: await planFor('people/dana-example') });
    const [dana] = await danaOf();
    expect((await h.fm(dana!.retired)).merged_into).toBe(dana!.canonical);
    const out = await h.json(['reject', dana!.collapse]);
    expect(out.collapses).toEqual([expect.objectContaining({ status: 'undone', store: 'git' })]);
    for (const path of Object.keys(files)) expect(read(path)).not.toMatch(/merged_into|dedupe_collapse|- Dana Example/);
    expect(Object.keys(files).some(path => read(path).includes('distinct_from:'))).toBe(true);
    if (git(root, 'status', '--porcelain')) git(root, 'commit', '-qam', 'distinct_from written by the reject');
    expect(git(root, 'show', `HEAD:${IDENTITY_DIR}/${dana!.collapse}.md`)).toContain('verdict: different');
    expect(await planFor('people/dana-example')).toEqual([]);
    const [hal] = await planFor('people/hal-example');
    await applyAutoLinks(engine, { ...(await planAutoLinks(engine)), links: [], collapses: [hal!] });
    expect(read(`${hal!.retired}.md`)).toContain('merged_into: people/hal-example');
    const off = await h.json(['auto', '--off', 'C7']);
    expect(off.removed).toEqual([hal!.collapse]);
    for (const path of ['people/hal-example.md', 'people/hal-example-2.md']) expect(read(path)).toBe(extra[path]!);
    expect(git(root, 'status', '--porcelain')).toBe('');
    await h.dedupe(['auto', '--on', 'C7']);
  });

  test('in git, a file with edits not committed yet is left alone, so a collapse commit never carries them', async () => {
    const [hal] = await planFor('people/hal-example');
    const path = `${hal!.retired}.md`;
    const draft = `${read(path)}A draft line.\n`;
    writeFileSync(join(root, path), draft);
    const out = await applyAutoLinks(engine, { ...(await planAutoLinks(engine)), links: [], collapses: [hal!] });
    expect(out.collapses).toEqual([expect.objectContaining({ status: 'skipped', reason: 'uncommitted_changes', store: 'git' })]);
    expect(read(path)).toBe(draft);
    git(root, 'checkout', '--', path);
  });

  test('in git, a reject or a distinct_from committed after the plan is read under the lock and never written over', async () => {
    const [hal] = await planFor('people/hal-example');
    const plan = { ...(await planAutoLinks(engine)), links: [], collapses: [hal!] };
    const members = [{ source_id: 'default', slug: hal!.retired }, { source_id: 'default', slug: hal!.canonical }];
    await recordDecisions(engine, [{ verdict: 'different', members, group_id: null, entity_id: null, canonical: null, decided_by: 'owner' }], 'test: reject the pair');
    expect((await applyAutoLinks(engine, plan)).collapses).toEqual([expect.objectContaining({ status: 'skipped', reason: 'changed', store: 'git' })]);
    await h.dedupe(['undo', hal!.collapse]);
    const path = `${hal!.retired}.md`;
    const edited = read(path).replace('\n---\n', `\ndistinct_from: [${hal!.canonical}]\n---\n`);
    writeFileSync(join(root, path), edited);
    git(root, 'commit', '-qam', 'kept apart by hand');
    expect((await applyAutoLinks(engine, plan)).collapses).toEqual([expect.objectContaining({ status: 'skipped', reason: 'changed', store: 'git' })]);
    expect(read(path)).toBe(edited);
  });
});
