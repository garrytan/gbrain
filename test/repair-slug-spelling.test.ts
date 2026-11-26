/**
 * `gbrain repair slug-spelling --source <id>`: move pages stored under an older spelling of their name (capitals, or a
 * decomposed Unicode name) to the normal spelling (lowercase, then Unicode NFC), so a put and an import of the page work
 * again.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: the preview lists every page of one source whose slug is not its normal slug, as `move`, `needs_human`
 *     (a page already holds the normal slug, or two stored spellings share it: never moved) or `rename_file_first` (the page's file
 *     in a checkout is not at the normal path). `--apply --expect <hash> --yes` moves only the movable pages, one
 *     transaction per page, keeping the page id, versions, tags, timeline, links, facts, withdrawals, aliases and
 *     attachments (`files.page_slug`; ids, storage paths and bytes unchanged); another source's rows are untouched.
 *     Anything that changed since the preview refuses `changed_since_preview` and moves nothing; a fault mid-apply rolls
 *     the page's move back; a second apply moves nothing; a managed brain refuses `managed_remedy_unavailable` and says a
 *     person is needed. The kind is explicit-only and trusted-local-only. After the move a put by the normal slug works
 *     and an import of the page's file is not held. The put refusal names the preview command.
 *  2. Regression: PR 9944 refused a put by an older spelling with "a fix is coming" and no way out except manual SQL.
 *  3. Existing coverage: test/slug-legacy-rows.test.ts and test/slug-normalize-reads.test.ts pin the refusal and the
 *     held import, not a way to move the page.
 *  4. Seam: none. Real PGLite engine, the repair command, registry operations. The schema guard imports the repair
 *     module's column lists dynamically, because a list kept next to the code is what stops a new slug-keyed table
 *     being missed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { renderTakesFence, type ParsedTake } from '../src/core/takes-fence.ts';
import { loadFenceChunkOverlay } from '../src/core/eligibility/fence-overlay.ts';
import { holdFingerprint } from '../src/core/write-gate-store.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-slug-spelling-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_INTERACTIVE: '0', CI: '1' };
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1').catch(() => undefined);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => _resetCliExitVerdictForTests());

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await fn(); } finally { console.log = original; process.stdout.write = write; }
  return printed;
}
const repair = async (args: string[]) => {
  const { runRepairCommand } = await import('../src/commands/repair.ts');
  return capture(() => runRepairCommand(engine, args));
};
const repairJson = async (args: string[]) => JSON.parse(await repair([...args, '--json'])).results[0];
async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}
const ctx = (sourceId = 'default'): OperationContext => ({ engine, config: { engine: 'pglite', embedding_disabled: true } as never, remote: false, sourceId, dryRun: false, logger: quiet }) as OperationContext;
const call = async <T = Record<string, any>>(name: string, params: Record<string, unknown>, sourceId = 'default') => await operationsByName[name]!.handler(ctx(sourceId), params) as T;
const page = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n${body}\n`;

/** A fresh source, so each case previews only its own pages; with a checkout directory when `checkout` is set. */
async function newSource(checkout = false) {
  const id = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const root = checkout ? join(home, id) : null;
  if (root) { mkdirSync(root, { recursive: true }); execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']); }
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  return { id, root };
}
/** A page stored under `stored`, as an older writer left it. */
async function storeAs(sourceId: string, stored: string, title = 'Old page', body = 'old body') {
  const seed = `seed/${randomUUID().slice(0, 8)}`;
  await engine.putPage(seed, { type: 'note', title, compiled_truth: body, timeline: '' }, { sourceId });
  await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2 AND source_id = $3', [stored, seed, sourceId]);
  await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = $1 AND source_id = $2', [stored, sourceId]);
  return (await row(sourceId, stored))!;
}
const row = async (sourceId: string, slug: string) => (await engine.executeRaw<{ id: number; slug: string; knowledge_revision: string; source_path: string | null; deleted_at: string | null }>(
  'SELECT id, slug, knowledge_revision::text AS knowledge_revision, source_path, deleted_at FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0];
const slugsOf = async (sourceId: string) => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1', [sourceId])).map(r => r.slug).sort();
const previewArgs = (id: string) => ['slug-spelling', '--source', id];
const applyArgs = (id: string, hash: string) => [...previewArgs(id), '--apply', '--expect', hash, '--yes'];
const classes = (preview: { listing?: Array<{ item: string; class: string }> }) => Object.fromEntries((preview.listing ?? []).map(entry => [entry.item, entry.class]));

describe('preview', () => {
  test('lists movable pages, collisions and a file that must be renamed first, each with its class and a source-qualified fix', () => withEnv(env, async () => {
    const s = await newSource(true);
    await storeAs(s.id, 'Notes/Alpha-Move');
    await storeAs(s.id, 'notes/cafe\u0301-move');
    await storeAs(s.id, 'Notes/Collide');
    await engine.putPage('notes/collide', { type: 'note', title: 'Holds the normal slug', compiled_truth: 'x', timeline: '' }, { sourceId: s.id });
    await storeAs(s.id, 'Notes/Twins');
    await storeAs(s.id, 'NOTES/TWINS');
    const filed = await storeAs(s.id, 'Docs/Filed');
    mkdirSync(join(s.root!, 'Docs'), { recursive: true });
    writeFileSync(join(s.root!, 'Docs/Filed.md'), page('Filed', 'file body'));
    await engine.executeRaw("UPDATE pages SET source_path='Docs/Filed.md' WHERE id=$1", [filed.id]);
    const proven = await storeAs(s.id, 'Docs/Ok');
    mkdirSync(join(s.root!, 'docs'), { recursive: true });
    writeFileSync(join(s.root!, 'docs/ok.md'), page('Ok', 'file body'));
    await engine.executeRaw("UPDATE pages SET source_path='docs/ok.md' WHERE id=$1", [proven.id]);

    const preview = await repairJson(previewArgs(s.id));
    expect(structuredClone(preview)).toMatchObject({ kind: 'slug-spelling', mode: 'dry_run', preview_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(classes(preview)).toEqual({
      [`${s.id}:Notes/Alpha-Move`]: 'move', [`${s.id}:notes/cafe\u0301-move`]: 'move', [`${s.id}:Docs/Ok`]: 'move',
      [`${s.id}:Notes/Collide`]: 'needs_human', [`${s.id}:Notes/Twins`]: 'needs_human', [`${s.id}:NOTES/TWINS`]: 'needs_human',
      [`${s.id}:Docs/Filed`]: 'rename_file_first',
    });
    expect(preview.apply_command).toBe(`gbrain repair slug-spelling --source ${s.id} --apply --expect ${preview.preview_hash} --yes`);
    const details = preview.details as { items: Array<{ slug: string; code?: string; fix?: { argv?: string[]; verify?: { argv?: string[] } } }> };
    const bySlug = Object.fromEntries(details.items.map(item => [item.slug, item]));
    expect(bySlug['Notes/Collide']).toMatchObject({ code: 'slug_spelling_collision' });
    expect(bySlug['Docs/Filed']).toMatchObject({ code: 'rename_file_first' });
    for (const slug of ['Notes/Collide', 'Notes/Twins']) expect(bySlug[slug]!.fix?.argv?.join(' ')).toContain(`--source ${s.id}`);
    expect(bySlug['Docs/Filed']!.fix?.argv).toEqual(['git', '-C', s.root!, 'mv', 'Docs/Filed.md', 'docs/filed.md']);
    for (const slug of ['Notes/Collide', 'Notes/Twins', 'Docs/Filed']) {
      expect(bySlug[slug]!.fix?.verify?.argv?.join(' ')).toContain(`gbrain repair slug-spelling --source ${s.id}`);
    }
    expect(JSON.stringify(bySlug['Docs/Filed'])).toContain('git mv');
    // A preview writes nothing.
    expect(await slugsOf(s.id)).toContain('Notes/Alpha-Move');
  }));

  test('a source with nothing to move prints an empty preview whose hash still applies nothing', () => withEnv(env, async () => {
    const s = await newSource();
    await engine.putPage('notes/fine', { type: 'note', title: 'Fine', compiled_truth: 'x', timeline: '' }, { sourceId: s.id });
    const preview = await repairJson(previewArgs(s.id));
    expect(preview.affected).toBe(0);
    const applied = await repairJson(applyArgs(s.id, preview.preview_hash));
    expect(applied).toMatchObject({ mode: 'apply', applied: 0, failed: [] });
  }));

  test('it is explicit-only: --all never runs it, and a remote caller is refused', () => withEnv(env, async () => {
    const s = await newSource();
    await storeAs(s.id, 'Notes/Never-Auto');
    const all = JSON.parse(await repair(['--all', '--json']));
    expect(all.results.map((r: { kind: string }) => r.kind)).not.toContain('slug-spelling');
    expect(await slugsOf(s.id)).toEqual(['Notes/Never-Auto']);
    const { repairSpec } = await import('../src/core/repair/registry.ts');
    const spec = repairSpec('slug-spelling' as never);
    expect(spec).toMatchObject({ explicit_only: true, preview_bound: true, consent: 'destructive' });
    const error = await refusal(() => spec.handler.plan(engine, { brain_id: 'host', source_ids: [s.id] }, null, { apply: false, remote: true }));
    expect(error.code).toBe('permission_denied');
  }));
});

describe('apply', () => {
  test('moves only the movable pages and keeps the page id, versions, tags, timeline, links, facts, withdrawals, aliases and attachments', () => withEnv(env, async () => {
    const s = await newSource();
    const other = await newSource();
    const peer = await engine.putPage('notes/peer', { type: 'note', title: 'Peer', compiled_truth: 'peer', timeline: '' }, { sourceId: s.id });
    const old = await storeAs(s.id, 'Notes/Alpha-Move', 'Alpha', 'alpha body');
    await storeAs(s.id, 'Notes/Collide');
    await engine.putPage('notes/collide', { type: 'note', title: 'Holds the normal slug', compiled_truth: 'x', timeline: '' }, { sourceId: s.id });
    const otherPage = await storeAs(other.id, 'Notes/Alpha-Move', 'Other source alpha', 'other body');
    const peerId = (await row(s.id, 'notes/peer'))!.id;
    expect(peer).toBeDefined();
    await engine.executeRaw("INSERT INTO page_versions(page_id, compiled_truth, frontmatter) VALUES($1, 'an earlier body', '{}')", [old.id]);
    await engine.executeRaw('INSERT INTO tags (page_id, tag) VALUES ($1, $2)', [old.id, 'kept-tag']);
    await engine.executeRaw("INSERT INTO timeline_entries(page_id, date, source, summary) VALUES($1, '2026-01-05', 'test', 'Planning kickoff')", [old.id]);
    await engine.executeRaw("INSERT INTO links(from_page_id,to_page_id,link_type,link_source) VALUES($1,$2,'mentions','test')", [old.id, peerId]);
    await engine.insertFact({ fact: 'Alpha is owned by the platform team', entity_slug: 'Notes/Alpha-Move', visibility: 'world', source: 'synthetic' }, { source_id: s.id });
    await engine.insertFacts([{ fact: 'Alpha ships payments', kind: 'fact', visibility: 'world', notability: 'medium', source: 'fence:reconcile', entity_slug: 'Notes/Alpha-Move', row_num: 1, source_markdown_slug: 'Notes/Alpha-Move' }], { source_id: s.id });
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash) VALUES($1,'world','Notes/Alpha-Move','h1')", [s.id]);
    await engine.executeRaw("INSERT INTO page_aliases(source_id, alias_norm, slug) VALUES($1,'alpha nickname','Notes/Alpha-Move')", [s.id]);
    await engine.executeRaw("INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, content_hash, size_bytes) VALUES ($1,'Notes/Alpha-Move',$2,'a.txt',$3,'hash-a',11)", [s.id, old.id, `${s.id}/a.txt`]);
    await engine.executeRaw("INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, content_hash, size_bytes) VALUES ($1,'Notes/Alpha-Move',NULL,'orphan.txt',$2,'hash-b',5)", [s.id, `${s.id}/orphan.txt`]);
    await engine.executeRaw("INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, content_hash, size_bytes) VALUES ($1,'Notes/Alpha-Move',$2,'other.txt',$3,'hash-c',7)", [other.id, otherPage.id, `${other.id}/other.txt`]);
    const filesBefore = await engine.executeRaw<{ id: number; storage_path: string; content_hash: string; size_bytes: number; filename: string }>(
      'SELECT id, storage_path, content_hash, size_bytes::int AS size_bytes, filename FROM files WHERE source_id=$1 ORDER BY id', [s.id]);
    const versionsBefore = Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id=$1', [old.id]))[0]!.n);

    const preview = await repairJson(previewArgs(s.id));
    expect(classes(preview)).toEqual({ [`${s.id}:Notes/Alpha-Move`]: 'move', [`${s.id}:Notes/Collide`]: 'needs_human' });
    const applied = await repairJson(applyArgs(s.id, preview.preview_hash));
    expect(applied).toMatchObject({ mode: 'apply', applied: 1, failed: [], complete: true, outcomes: { moved: 1 } });

    // The page keeps its id; the collision stays where it was.
    expect(await slugsOf(s.id)).toEqual(['Notes/Collide', 'notes/alpha-move', 'notes/collide', 'notes/peer']);
    expect((await row(s.id, 'notes/alpha-move'))!.id).toBe(old.id);
    expect(Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id=$1', [old.id]))[0]!.n)).toBeGreaterThanOrEqual(versionsBefore);
    expect((await engine.executeRaw<{ tag: string }>('SELECT tag FROM tags WHERE page_id=$1', [old.id])).map(r => r.tag)).toEqual(['kept-tag']);
    expect((await engine.executeRaw<{ summary: string }>('SELECT summary FROM timeline_entries WHERE page_id=$1', [old.id])).map(r => r.summary)).toEqual(['Planning kickoff']);
    expect(Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM links WHERE from_page_id=$1 AND to_page_id=$2', [old.id, peerId]))[0]!.n)).toBe(1);
    // Facts, withdrawals and aliases follow the page.
    const facts = await engine.executeRaw<{ entity_slug: string; source_markdown_slug: string | null }>('SELECT entity_slug, source_markdown_slug FROM facts WHERE source_id=$1 ORDER BY id', [s.id]);
    expect(facts).toEqual([{ entity_slug: 'notes/alpha-move', source_markdown_slug: null }, { entity_slug: 'notes/alpha-move', source_markdown_slug: 'notes/alpha-move' }]);
    expect((await engine.executeRaw<{ subject: string }>('SELECT subject FROM fact_withdrawals WHERE source_id=$1', [s.id])).map(r => r.subject)).toEqual(['notes/alpha-move']);
    expect((await engine.executeRaw<{ slug: string }>('SELECT slug FROM page_aliases WHERE source_id=$1', [s.id])).map(r => r.slug)).toEqual(['notes/alpha-move']);
    // Attachments: only page_slug changes (the row with no page id and the old slug in this source moves too).
    const filesAfter = await engine.executeRaw<{ id: number; storage_path: string; content_hash: string; size_bytes: number; filename: string; page_slug: string }>(
      'SELECT id, storage_path, content_hash, size_bytes::int AS size_bytes, filename, page_slug FROM files WHERE source_id=$1 ORDER BY id', [s.id]);
    expect(filesAfter.map(({ page_slug: _slug, ...rest }) => rest)).toEqual(filesBefore);
    expect(filesAfter.map(f => f.page_slug)).toEqual(['notes/alpha-move', 'notes/alpha-move']);
    expect((await call<Array<{ filename: string }>>('file_list', { slug: 'notes/alpha-move' }, s.id)).map(f => f.filename).sort()).toEqual(['a.txt', 'orphan.txt']);
    // The other source is untouched.
    expect(await slugsOf(other.id)).toEqual(['Notes/Alpha-Move']);
    expect((await engine.executeRaw<{ page_slug: string }>('SELECT page_slug FROM files WHERE source_id=$1', [other.id])).map(r => r.page_slug)).toEqual(['Notes/Alpha-Move']);
    // The old spelling keeps resolving, through an alias.
    expect((await engine.executeRaw<{ canonical_slug: string }>('SELECT canonical_slug FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2', [s.id, 'Notes/Alpha-Move'])).map(r => r.canonical_slug)).toEqual(['notes/alpha-move']);
    expect((await call('get_page', { slug: 'Notes/Alpha-Move', source_id: s.id }, s.id)).title).toBe('Alpha');
    // Receipts: the outcome names the page and both spellings.
    expect(applied.outcome_items[0]).toMatchObject({ outcome: 'moved', detail: { page_id: old.id, from: 'Notes/Alpha-Move', to: 'notes/alpha-move', attachments_moved: 2 } });
  }));

  test('a decomposed spelling moves to the composed one; a second apply of the same preview moves nothing', () => withEnv(env, async () => {
    const s = await newSource();
    const stored = 'notes/cafe\u0301-again';
    const old = await storeAs(s.id, stored);
    const preview = await repairJson(previewArgs(s.id));
    const first = await repairJson(applyArgs(s.id, preview.preview_hash));
    expect(first).toMatchObject({ applied: 1, outcomes: { moved: 1 } });
    expect((await row(s.id, 'notes/caf\u00e9-again'))!.id).toBe(old.id);
    const revision = (await row(s.id, 'notes/caf\u00e9-again'))!.knowledge_revision;
    const second = await repairJson(applyArgs(s.id, preview.preview_hash));
    expect(second).toMatchObject({ applied: 0, failed: [], outcomes: { already_moved: 1 } });
    expect((await row(s.id, 'notes/caf\u00e9-again'))!.knowledge_revision).toBe(revision);
    expect(await slugsOf(s.id)).toEqual(['notes/caf\u00e9-again']);
  }));

  test('a page whose recorded file is already at the normal path moves and keeps its recorded path', () => withEnv(env, async () => {
    const s = await newSource(true);
    const proven = await storeAs(s.id, 'Docs/Proven');
    mkdirSync(join(s.root!, 'docs'), { recursive: true });
    writeFileSync(join(s.root!, 'docs/proven.md'), page('Proven', 'file body'));
    await engine.executeRaw("UPDATE pages SET source_path='docs/proven.md' WHERE id=$1", [proven.id]);
    const preview = await repairJson(previewArgs(s.id));
    await repairJson(applyArgs(s.id, preview.preview_hash));
    expect(await row(s.id, 'docs/proven')).toMatchObject({ id: proven.id, source_path: 'docs/proven.md' });
  }));

  test('each change after the preview refuses changed_since_preview and moves nothing', () => withEnv(env, async () => {
    const changes: Array<[string, (s: { id: string; root: string | null }, pageId: number) => Promise<void>]> = [
      ['revision', async (s, id) => { await engine.executeRaw("UPDATE pages SET compiled_truth='edited after the preview' WHERE id=$1", [id]); expect(await row(s.id, 'Notes/Moved')).toBeDefined(); }],
      ['recorded origin', async (_s, id) => { await engine.executeRaw("UPDATE pages SET source_path='notes/other-origin.md' WHERE id=$1", [id]); }],
      ['source incarnation', async s => { await engine.executeRaw('DELETE FROM page_write_guards WHERE source_incarnation=(SELECT incarnation FROM sources WHERE id=$1)', [s.id]); await engine.executeRaw('UPDATE sources SET incarnation = gen_random_uuid() WHERE id=$1', [s.id]); }],
      ['a new old-spelling file', async s => { mkdirSync(join(s.root!, 'Notes'), { recursive: true }); writeFileSync(join(s.root!, 'Notes/Moved.md'), page('Moved', 'a file under the old spelling')); }],
      ['the normal slug taken', async s => { await engine.putPage('notes/moved', { type: 'note', title: 'Took it', compiled_truth: 'x', timeline: '' }, { sourceId: s.id }); }],
    ];
    for (const [name, change] of changes) {
      const s = await newSource(true);
      const old = await storeAs(s.id, 'Notes/Moved');
      const preview = await repairJson(previewArgs(s.id));
      expect(classes(preview)).toEqual({ [`${s.id}:Notes/Moved`]: 'move' });
      const before = await row(s.id, 'Notes/Moved');
      await change(s, old.id);
      const error = await refusal(() => repairJson(applyArgs(s.id, preview.preview_hash)));
      expect({ name, code: error.code }).toEqual({ name, code: 'changed_since_preview' });
      expect(error.fix?.argv?.join(' ')).toContain(`gbrain repair slug-spelling --source ${s.id}`);
      expect(error.fix?.verify?.argv?.join(' ')).toContain('gbrain repair slug-spelling');
      expect(error.suggestion).toContain('Preview again');
      const after = await row(s.id, 'Notes/Moved');
      expect({ name, id: after?.id, slug: after?.slug }).toEqual({ name, id: before!.id, slug: 'Notes/Moved' });
      expect((await engine.executeRaw('SELECT 1 FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2', [s.id, 'Notes/Moved'])).length).toBe(0);
    }
  }), 120_000);

  test('a fault part way through the page move rolls the whole move back', () => withEnv(env, async () => {
    const s = await newSource();
    const old = await storeAs(s.id, 'Notes/Fault-Page');
    await engine.insertFact({ fact: 'A fact about the page', entity_slug: 'Notes/Fault-Page', visibility: 'world', source: 'synthetic' }, { source_id: s.id });
    await engine.executeRaw("INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, content_hash, size_bytes) VALUES ($1,'Notes/Fault-Page',$2,'f.txt',$3,'hash-f',3)", [s.id, old.id, `${s.id}/f.txt`]);
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION slug_spelling_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.page_slug = 'notes/fault-page' THEN RAISE EXCEPTION 'injected fault'; END IF; RETURN NEW; END $$`);
    await engine.executeRaw('CREATE TRIGGER slug_spelling_fault BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION slug_spelling_fault()');
    try {
      const preview = await repairJson(previewArgs(s.id));
      const applied = await repairJson(applyArgs(s.id, preview.preview_hash)).catch((error: Error) => error);
      expect(applied instanceof Error ? applied.message : JSON.stringify((applied as { failed: unknown }).failed)).toContain('injected fault');
    } finally {
      await engine.executeRaw('DROP TRIGGER IF EXISTS slug_spelling_fault ON files');
    }
    expect(await slugsOf(s.id)).toEqual(['Notes/Fault-Page']);
    expect((await engine.executeRaw<{ entity_slug: string }>('SELECT entity_slug FROM facts WHERE source_id=$1', [s.id])).map(r => r.entity_slug)).toEqual(['Notes/Fault-Page']);
    expect((await engine.executeRaw<{ page_slug: string }>('SELECT page_slug FROM files WHERE source_id=$1', [s.id])).map(r => r.page_slug)).toEqual(['Notes/Fault-Page']);
    expect((await engine.executeRaw('SELECT 1 FROM slug_aliases WHERE source_id=$1', [s.id])).length).toBe(0);
  }));
});

describe('guards that follow the page to its normal slug', () => {
  const fenceRow = (rowNum: number, claim: string): ParsedFact => ({ rowNum, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', validFrom: '2024-01-01', source: 'user', active: true });
  const fingerprintOf = async (claim: string) => (await engine.executeRaw<{ fp: string }>('SELECT gbrain_fact_fingerprint($1) AS fp', [claim]))[0]!.fp;
  const purged = async (run: () => Promise<unknown>) => String(await run().then(() => 'saved', e => (e as Error).message));

  test('purges scoped to the old spelling keep refusing the same claims under the normal slug, with their metadata, for facts and takes', () => withEnv(env, async () => {
    const s = await newSource();
    const old = await storeAs(s.id, 'Notes/Purge-Move', 'Purge page', 'body');
    const factClaim = 'Alpha was acquired by acme-example in 2019', takeClaim = 'Alpha will win the market';
    const request = randomUUID();
    await engine.executeRaw(`INSERT INTO fact_purges(source_id, visibility, subject, fact_hash, request_id, actor, reason, purged_at) VALUES ($1,'world','Notes/Purge-Move',$2,$3,'alice-example','asked to forget','2026-01-02T03:04:05Z')`, [s.id, await fingerprintOf(factClaim), request]);
    await engine.executeRaw(`INSERT INTO take_purges(source_id, subject, claim_hash, request_id, purged_at) VALUES ($1,'Notes/Purge-Move',$2,$3,'2026-01-03T03:04:05Z')`, [s.id, await fingerprintOf(takeClaim), request]);
    // A tombstone the normal slug already holds (older than the copy) is kept as it is.
    await engine.executeRaw(`INSERT INTO fact_purges(source_id, visibility, subject, fact_hash, actor, purged_at) VALUES ($1,'world','Notes/Purge-Move',$2,'alice-example','2026-02-01T00:00:00Z'), ($1,'world','notes/purge-move',$2,'bob-example','2026-01-01T00:00:00Z')`, [s.id, await fingerprintOf('A claim both spellings purged')]);

    const preview = await repairJson(previewArgs(s.id));
    await repairJson(applyArgs(s.id, preview.preview_hash));
    expect(await row(s.id, 'notes/purge-move')).toMatchObject({ id: old.id });

    expect(await purged(() => engine.insertFact({ fact: factClaim, entity_slug: 'notes/purge-move', visibility: 'world', source: 'synthetic' }, { source_id: s.id }))).toContain('purged_content');
    expect(await purged(() => engine.addTakesBatch([{ page_id: old.id, row_num: 1, claim: takeClaim, kind: 'take', holder: 'brain', weight: 0.5 }]))).toContain('purged_content');
    // The page's file imported again with both claims: neither comes back.
    const body = `---\ntitle: Purge page\ntype: note\n---\nBody.\n\n## Facts\n\n${renderFactsTable([fenceRow(1, factClaim), fenceRow(2, 'An unrelated kept claim')])}\n\n${renderTakesFence([{ rowNum: 1, claim: takeClaim, kind: 'take', holder: 'world', weight: 0.5, active: true } as ParsedTake])}\n`;
    const imported = await importFromContent(engine, 'notes/purge-move', body, { noEmbed: true, sourceId: s.id });
    expect(imported.status).toBe('imported');
    expect((await engine.executeRaw('SELECT 1 FROM facts WHERE source_id=$1 AND fact=$2', [s.id, factClaim])).length).toBe(0);
    expect((await engine.executeRaw('SELECT 1 FROM takes WHERE page_id=$1 AND claim=$2', [old.id, takeClaim])).length).toBe(0);
    // Metadata moved with the tombstones; a tombstone already under the normal slug is not overwritten.
    expect(await engine.executeRaw('SELECT actor, reason, request_id::text AS request_id, purged_at::text AS purged_at FROM fact_purges WHERE source_id=$1 AND subject=$2 AND fact_hash=$3', [s.id, 'notes/purge-move', await fingerprintOf(factClaim)]))
      .toEqual([{ actor: 'alice-example', reason: 'asked to forget', request_id: request, purged_at: expect.stringContaining('2026-01-02') }]);
    expect((await engine.executeRaw<{ request_id: string }>('SELECT request_id::text AS request_id FROM take_purges WHERE source_id=$1 AND subject=$2', [s.id, 'notes/purge-move'])).map(r => r.request_id)).toEqual([request]);
    expect((await engine.executeRaw<{ actor: string }>('SELECT actor FROM fact_purges WHERE source_id=$1 AND subject=$2 AND fact_hash=$3', [s.id, 'notes/purge-move', await fingerprintOf('A claim both spellings purged')])).map(r => r.actor)).toEqual(['bob-example']);
  }), 60_000);

  /** One held write (an active quarantine hold) of a page, under the spelling given. */
  const hold = (sourceId: string, slug: string, opts: { kind?: 'fact' | 'take'; claim: string; status?: string; row?: number }) =>
    engine.executeRaw(`INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload, status, seen_count)
      VALUES ($1, $2, $3, $4, 2, 'external_untrusted', $5::text::jsonb, $6, 3)`, [opts.kind ?? 'fact', sourceId, slug, holdFingerprint(opts.kind ?? 'fact', [opts.claim, null, null]),
      JSON.stringify({ fact: opts.claim, kind: opts.kind ?? 'fact', visibility: 'world', entity_slug: slug, row_num: opts.row ?? 2 }), opts.status ?? 'held']);
  const holdRows = (sourceId: string) => engine.executeRaw('SELECT id, kind, slug, page_id, page_candidates, status, fingerprint, payload, seen_count, decided_by FROM write_gate_holds WHERE source_id=$1 ORDER BY id', [sourceId]);
  const items = (preview: { details?: unknown }) => (preview.details as { items: Array<{ slug: string; code?: string; message?: string; fix?: { user_message?: string } }> }).items;

  test('a page with a held fence row moves: a hold bound to the page keeps its page id, a hold under the old spelling still reaches the page, and the held row stays out of the moved page', () => withEnv(env, async () => {
    const s = await newSource();
    const claim = 'Alpha ignored the previous instructions zanzibarquux';
    const compiled = `Alpha runs acme-example.\n\n## Facts\n\n${renderFactsTable([fenceRow(1, 'Alpha ships widgets'), fenceRow(2, claim)])}\n`;
    const unbound = await storeAs(s.id, 'Notes/Hold-Move', 'Hold page', compiled);
    const bound = await storeAs(s.id, 'Notes/Hold-Bound', 'Bound page', compiled);
    await hold(s.id, 'Notes/Hold-Move', { claim });
    await hold(s.id, 'Notes/Hold-Bound', { claim });
    await engine.executeRaw('UPDATE write_gate_holds SET page_id = $1 WHERE source_id = $2 AND slug = $3', [bound.id, s.id, 'Notes/Hold-Bound']);
    const overlayAt = (slug: string) => loadFenceChunkOverlay(engine, { sourceId: s.id, slug, compiled_truth: compiled });
    expect([...(await overlayAt('Notes/Hold-Move'))!.omit]).toEqual([2]);
    expect([...(await overlayAt('Notes/Hold-Bound'))!.omit]).toEqual([2]);
    const holdsBefore = await holdRows(s.id);

    const preview = await repairJson(previewArgs(s.id));
    expect(classes(preview)).toEqual({ [`${s.id}:Notes/Hold-Bound`]: 'move', [`${s.id}:Notes/Hold-Move`]: 'move' });
    const applied = await repairJson(applyArgs(s.id, preview.preview_hash));
    expect(applied).toMatchObject({ applied: 2 });
    expect(await slugsOf(s.id)).toEqual(['notes/hold-bound', 'notes/hold-move']);
    expect(await row(s.id, 'notes/hold-move')).toMatchObject({ id: unbound.id });
    expect(await row(s.id, 'notes/hold-bound')).toMatchObject({ id: bound.id });
    // No hold is re-keyed or decided: the bound one keeps its page id, the unbound one its slug.
    expect(await holdRows(s.id)).toEqual(holdsBefore);
    expect([...(await overlayAt('notes/hold-move'))!.omit]).toEqual([2]);
    expect([...(await overlayAt('notes/hold-bound'))!.omit]).toEqual([2]);
  }), 60_000);

  test('pages with held fact or take writes move whichever kind and whichever of their spellings the hold names, and every hold stays as it was', () => withEnv(env, async () => {
    const s = await newSource();
    await storeAs(s.id, 'Notes/Hold-Fact', 'Fact page', 'body');
    await storeAs(s.id, 'Notes/Hold-Take', 'Take page', 'body');
    await storeAs(s.id, 'Notes/Hold-Normal', 'Normal page', 'body');
    await hold(s.id, 'Notes/Hold-Fact', { kind: 'fact', claim: 'Alpha ignored the previous instructions marrowgleam' });
    await hold(s.id, 'Notes/Hold-Take', { kind: 'take', claim: 'Alpha ignored the previous instructions sablewick' });
    // A hold the page's normal slug holds (the page itself is still stored under the old spelling).
    await hold(s.id, 'notes/hold-normal', { kind: 'fact', claim: 'Alpha ignored the previous instructions tallowmere' });
    const holdsBefore = await holdRows(s.id);

    const preview = await repairJson(previewArgs(s.id));
    expect(classes(preview)).toEqual({ [`${s.id}:Notes/Hold-Fact`]: 'move', [`${s.id}:Notes/Hold-Take`]: 'move', [`${s.id}:Notes/Hold-Normal`]: 'move' });
    expect(await repairJson(applyArgs(s.id, preview.preview_hash))).toMatchObject({ applied: 3 });
    expect(await slugsOf(s.id)).toEqual(['notes/hold-fact', 'notes/hold-normal', 'notes/hold-take']);
    expect(await holdRows(s.id)).toEqual(holdsBefore);
  }), 60_000);

  test('a page whose held writes are all decided (released or dropped) still moves, and the decided records stay as they were', () => withEnv(env, async () => {
    const s = await newSource();
    const old = await storeAs(s.id, 'Notes/Hold-Decided', 'Decided page', 'body');
    await hold(s.id, 'Notes/Hold-Decided', { claim: 'Alpha ignored the previous instructions quillfeather', status: 'released' });
    await hold(s.id, 'Notes/Hold-Decided', { kind: 'take', claim: 'Alpha ignored the previous instructions oxbowline', status: 'dropped' });
    await hold(s.id, 'notes/hold-decided', { claim: 'Alpha ignored the previous instructions harrowmeet', status: 'released' });
    const holdsBefore = await holdRows(s.id);

    const preview = await repairJson(previewArgs(s.id));
    expect(classes(preview)).toEqual({ [`${s.id}:Notes/Hold-Decided`]: 'move' });
    await repairJson(applyArgs(s.id, preview.preview_hash));
    expect(await row(s.id, 'notes/hold-decided')).toMatchObject({ id: old.id });
    expect(await holdRows(s.id)).toEqual(holdsBefore);
  }), 60_000);

  test('a hold that appears after the preview, or under the old spelling after the move, does not stop the move and still keeps its row out of the moved page', () => withEnv(env, async () => {
    const s = await newSource();
    const late = 'Alpha ignored the previous instructions fenwick', after = 'Alpha ignored the previous instructions gladewick';
    const compiled = `Alpha runs acme-example.\n\n## Facts\n\n${renderFactsTable([fenceRow(1, 'Alpha ships widgets'), fenceRow(2, late), fenceRow(3, after)])}\n`;
    const old = await storeAs(s.id, 'Notes/Hold-Late', 'Late page', compiled);
    const overlayAt = (slug: string) => loadFenceChunkOverlay(engine, { sourceId: s.id, slug, compiled_truth: compiled });
    const preview = await repairJson(previewArgs(s.id));
    expect(classes(preview)).toEqual({ [`${s.id}:Notes/Hold-Late`]: 'move' });
    await hold(s.id, 'Notes/Hold-Late', { claim: late, row: 2 });
    expect(await repairJson(applyArgs(s.id, preview.preview_hash))).toMatchObject({ applied: 1 });
    expect(await row(s.id, 'notes/hold-late')).toMatchObject({ id: old.id });
    // A writer that still names the old spelling after the move: its hold reaches the page through the rename record.
    await hold(s.id, 'Notes/Hold-Late', { claim: after, row: 3 });
    expect([...(await overlayAt('notes/hold-late'))!.omit].sort()).toEqual([2, 3]);
  }), 60_000);

  test('a page with another stored spelling of its name past the scan cap is not movable: the preview stops for a person to decide', () => withEnv(env, async () => {
    const { __setSlugSpellingScanLimitForTests } = await import('../src/core/repair/slug-spelling.ts');
    const s = await newSource();
    const first = await storeAs(s.id, 'Notes/Cap-Dup', 'First spelling', 'one');
    // Pages already in normal form that the scan still reads (non-ASCII slugs), so the cap runs out before the second spelling.
    for (const n of [1, 2, 3]) await engine.putPage(`notes/nöte-${n}`, { type: 'note', title: `Filler ${n}`, compiled_truth: 'x', timeline: '' }, { sourceId: s.id });
    const second = await storeAs(s.id, 'NOTES/CAP-DUP', 'Second spelling', 'two');
    __setSlugSpellingScanLimitForTests(3);
    try {
      const preview = await repairJson(previewArgs(s.id));
      expect(classes(preview)).toEqual({ [`${s.id}:Notes/Cap-Dup`]: 'needs_human' });
      const entry = items(preview).find(item => item.slug === 'Notes/Cap-Dup') as { code?: string; message?: string } | undefined;
      expect(entry?.code).toBe('slug_spelling_collision');
      expect(entry?.message).toContain(`NOTES/CAP-DUP (id ${second.id})`);
      if (preview.preview_hash) await repairJson(applyArgs(s.id, preview.preview_hash));
      expect(await row(s.id, 'Notes/Cap-Dup')).toMatchObject({ id: first.id });
      expect(await row(s.id, 'notes/cap-dup')).toBeUndefined();
    } finally {
      __setSlugSpellingScanLimitForTests();
    }
  }), 60_000);

  test('a write by the stored spelling and the repair take the same two page locks: the legacy key is locked too, and a change after the preview refuses', () => withEnv(env, async () => {
    const s = await newSource();
    await storeAs(s.id, 'Notes/Lock-Move');
    const preview = await repairJson(previewArgs(s.id));
    await repairJson(applyArgs(s.id, preview.preview_hash));
    const guards = (await engine.executeRaw<{ slug: string }>('SELECT g.slug FROM page_write_guards g JOIN sources x ON x.incarnation = g.source_incarnation WHERE x.id=$1 ORDER BY g.slug', [s.id])).map(r => r.slug);
    expect(guards).toEqual(expect.arrayContaining(['Notes/Lock-Move', 'notes/lock-move']));
  }));
});

describe('a recorded file the checkout does not have', () => {
  test('a subfolder source in git-root slug mode compares the file in the checkout\'s own coordinates, and suggests a rename the checkout accepts', () => withEnv(env, async () => {
    // The git repository holds the vault; the source is its notes/ folder, and git-root slugs keep the notes/ prefix.
    const id = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const vault = join(home, id);
    mkdirSync(join(vault, 'notes'), { recursive: true });
    execFileSync('git', ['-C', vault, 'init', '-q', '-b', 'main']);
    const root = join(vault, 'notes');
    await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{"slug_root_mode":"git-root"}')`, [id, root]);
    // Already at the normal path: notes/alice.md in the repository, alice.md in the source folder.
    const placed = await storeAs(id, 'NOTES/Alice');
    writeFileSync(join(root, 'alice.md'), page('Alice', 'file body'));
    await engine.executeRaw("UPDATE pages SET source_path='notes/alice.md' WHERE id=$1", [placed.id]);
    // Not yet renamed: notes/Bob.md, which must become notes/bob.md.
    const misplaced = await storeAs(id, 'NOTES/Bob');
    writeFileSync(join(root, 'Bob.md'), page('Bob', 'file body'));
    await engine.executeRaw("UPDATE pages SET source_path='notes/Bob.md' WHERE id=$1", [misplaced.id]);

    const preview = await repairJson(previewArgs(id));
    expect(classes(preview)).toEqual({ [`${id}:NOTES/Alice`]: 'move', [`${id}:NOTES/Bob`]: 'rename_file_first' });
    const bob = (preview.details as { items: Array<{ slug: string; fix?: { argv?: string[] } }> }).items.find(item => item.slug === 'NOTES/Bob');
    expect(bob?.fix?.argv).toEqual(['git', '-C', root, 'mv', 'Bob.md', 'bob.md']);
    // The text a person reads names the same rename, inside the source's folder.
    const bobText = (preview.details as { items: Array<{ slug: string; message?: string }> }).items.find(item => item.slug === 'NOTES/Bob')?.message ?? '';
    expect(bobText).toContain('git mv the file to bob.md,');
    expect(bobText).not.toContain('notes/bob.md');
    expect(await repairJson(applyArgs(id, preview.preview_hash))).toMatchObject({ applied: 1 });
    expect(await row(id, 'notes/alice')).toMatchObject({ id: placed.id });
  }), 60_000);

  test('a page that records its normal-path file with no such file in the checkout is rename_file_first and nothing moves', () => withEnv(env, async () => {
    const s = await newSource(true);
    const missing = await storeAs(s.id, 'Docs/Missing');
    await engine.executeRaw("UPDATE pages SET source_path='docs/missing.md' WHERE id=$1", [missing.id]);
    const preview = await repairJson(previewArgs(s.id));
    expect(classes(preview)).toEqual({ [`${s.id}:Docs/Missing`]: 'rename_file_first' });
    expect(JSON.stringify(preview)).toContain('recorded file is not in the checkout');
    const applied = await repairJson(applyArgs(s.id, preview.preview_hash));
    expect(applied).toMatchObject({ applied: 0 });
    expect(await slugsOf(s.id)).toEqual(['Docs/Missing']);
  }));

  test('a recorded file removed after the preview refuses changed_since_preview and moves nothing', () => withEnv(env, async () => {
    const s = await newSource(true);
    const proven = await storeAs(s.id, 'Docs/Vanishing');
    mkdirSync(join(s.root!, 'docs'), { recursive: true });
    writeFileSync(join(s.root!, 'docs/vanishing.md'), page('Vanishing', 'file body'));
    await engine.executeRaw("UPDATE pages SET source_path='docs/vanishing.md' WHERE id=$1", [proven.id]);
    const preview = await repairJson(previewArgs(s.id));
    expect(classes(preview)).toEqual({ [`${s.id}:Docs/Vanishing`]: 'move' });
    rmSync(join(s.root!, 'docs/vanishing.md'));
    const error = await refusal(() => repairJson(applyArgs(s.id, preview.preview_hash)));
    expect(error.code).toBe('changed_since_preview');
    expect(await slugsOf(s.id)).toEqual(['Docs/Vanishing']);
  }));
});

describe('managed brain', () => {
  test('the preview and the apply say a person is needed and name no command that would refuse again', () => withEnv(env, async () => {
    const s = await newSource();
    await storeAs(s.id, 'Notes/Managed-Page');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      const preview = await repairJson(previewArgs(s.id));
      expect(structuredClone(preview)).toMatchObject({ affected: 0, details: { code: 'managed_remedy_unavailable', needs_human: true },
        listing: [{ item: `${s.id}:Notes/Managed-Page`, class: 'managed_remedy_unavailable' }] });
      const error = await refusal(() => repairJson(applyArgs(s.id, 'f'.repeat(64))));
      expect(error.code).toBe('managed_remedy_unavailable');
      const text = `${error.message} ${error.suggestion}`;
      expect(text).toContain('person');
      expect(text).not.toContain('repair slug-spelling');
      expect(text).not.toContain('--close');
      expect(error.fix?.actor).toBe('user');
      expect(error.fix?.argv).toBeUndefined();
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
    expect(await slugsOf(s.id)).toEqual(['Notes/Managed-Page']);
  }));
});

describe('after the move', () => {
  test('a put by the normal slug works and an import of the page is no longer held', () => withEnv(env, async () => {
    const s = await newSource();
    await storeAs(s.id, 'Notes/Put-After', 'Before', 'before');
    await storeAs(s.id, 'Notes/Import-After', 'Before import', 'before');
    const content = page('After', 'new text');
    const held = await importFromContent(engine, 'Notes/Import-After', content, { noEmbed: true, sourceId: s.id });
    expect(held.status).toBe('error');
    const preview = await repairJson(previewArgs(s.id));
    await repairJson(applyArgs(s.id, preview.preview_hash));
    const revision = (await engine.readPageSnapshot('notes/put-after', { sourceId: s.id }))!.revision;
    const put = await call<{ slug: string }>('put_page', { slug: 'notes/put-after', content, source_id: s.id, expected_revision: revision, request_id: randomUUID() }, s.id);
    expect(put.slug).toBe('notes/put-after');
    const imported = await importFromContent(engine, 'Notes/Import-After', content, { noEmbed: true, sourceId: s.id });
    expect(imported.status).toBe('imported');
    expect(await slugsOf(s.id)).toEqual(['notes/import-after', 'notes/put-after']);
  }), 60_000);

  test('the put refusal names the preview command with the source', () => withEnv(env, async () => {
    const s = await newSource();
    await storeAs(s.id, 'Notes/Refused-Put');
    let error: OperationError | undefined;
    try { await call('put_page', { slug: 'Notes/Refused-Put', content: page('X', 'y'), source_id: s.id, request_id: randomUUID() }, s.id); } catch (e) { error = e as OperationError; }
    expect(error).toMatchObject({ code: 'invalid_params', detail: 'legacy_slug_spelling' });
    expect(error!.message).toContain(`gbrain repair slug-spelling --source ${s.id}`);
    expect(error!.message).not.toContain('is coming');
  }));

  test('on a managed brain the put refusal states the limit and names no repair command', () => withEnv(env, async () => {
    const s = await newSource();
    await storeAs(s.id, 'Notes/Managed-Put');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    let error: OperationError | undefined;
    try { await call('put_page', { slug: 'Notes/Managed-Put', content: page('X', 'y'), source_id: s.id, request_id: randomUUID() }, s.id); } catch (e) { error = e as OperationError; }
    finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
    expect(error).toMatchObject({ code: 'invalid_params', detail: 'legacy_slug_spelling' });
    expect(error!.message).toContain('managed');
    expect(error!.message).toContain('person');
    expect(error!.message).not.toContain('repair slug-spelling');
  }));
});

describe('doctor check legacy_slug_spellings', () => {
  const doctor = async () => {
    const { legacySlugSpellingsEntry } = await import('../src/commands/doctor/checks/legacy-slug-spellings.ts');
    return (await legacySlugSpellingsEntry.run({ engine } as unknown as DoctorContext)) as unknown as Array<{ name: string; status: string; message: string; details?: Record<string, any>; fix?: Record<string, any>; fix_unavailable_reason?: string }>;
  };

  test('warns with the count per source and the preview command, and is ok when nothing is left', () => withEnv(env, async () => {
    // Earlier cases left pages under older spellings; this case counts only its own.
    await engine.executeRaw("DELETE FROM pages WHERE slug <> lower(slug) OR slug ~ '[^ -~]'");
    const s = await newSource();
    await storeAs(s.id, 'Notes/Doctor-One');
    await storeAs(s.id, 'notes/doctor-cafe\u0301');
    const [finding] = await doctor();
    expect(finding).toMatchObject({ name: 'legacy_slug_spellings', status: 'warn' });
    expect(finding!.details!.by_source).toEqual(expect.arrayContaining([{ source_id: s.id, count: 2 }]));
    expect(finding!.message).toContain(`gbrain repair slug-spelling --source ${s.id}`);
    expect(finding!.fix!.argv).toEqual(['gbrain', 'repair', 'slug-spelling', '--source', s.id]);
    const preview = await repairJson(previewArgs(s.id));
    await repairJson(applyArgs(s.id, preview.preview_hash));
    const after = (await doctor())[0]!;
    expect((after.details!.by_source as Array<{ source_id: string }>).map(entry => entry.source_id)).not.toContain(s.id);
  }));

  test('a scan that stopped at its candidate limit with no older spelling found is never reported ok', async () => {
    const { legacySlugSpellingsEntry } = await import('../src/commands/doctor/checks/legacy-slug-spellings.ts');
    const { SLUG_SPELLING_SCAN_LIMIT } = await import('../src/core/repair/slug-spelling.ts');
    // Every candidate is a page already in normal form (a non-ASCII name), and there are more than the scan reads.
    let served = 0;
    // The seam is the typed members the check calls (readRowSecurityTables, listSlugSpellingCandidates), never statement text.
    const scanning = {
      readRowSecurityTables: (tables: readonly string[]) => engine.readRowSecurityTables(tables),
      listSlugSpellingCandidates: async (after: number) => {
        const rows = [] as Array<{ id: number; source_id: string; slug: string }>;
        for (let i = 1; i <= 5_000 && served < SLUG_SPELLING_SCAN_LIMIT + 10_000; i++, served++) rows.push({ id: after + i, source_id: 'default', slug: `notes/caf\u00e9-${after + i}` });
        return rows;
      },
    };
    const [finding] = (await legacySlugSpellingsEntry.run({ engine: scanning } as unknown as DoctorContext)) as unknown as Array<{ status: string; message: string; details?: Record<string, any> }>;
    expect(finding!.details!.truncated).toBe(true);
    expect(finding!.status).not.toBe('ok');
    expect(finding!.message).not.toContain('No page is stored under an older spelling');
  });

  test('on a managed brain the fix is for a person and names no repair command', () => withEnv(env, async () => {
    const s = await newSource();
    await storeAs(s.id, 'Notes/Doctor-Managed');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      const [finding] = await doctor();
      expect(finding).toMatchObject({ status: 'warn' });
      expect(finding!.message).toContain('person');
      expect(finding!.message).not.toContain('repair slug-spelling');
      expect(finding!.fix?.actor ?? finding!.fix_unavailable_reason).toBeDefined();
      expect(finding!.fix?.argv).toBeUndefined();
      expect(finding!.details).toMatchObject({ needs_human: true });
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  }));
});

describe('schema guard: every column that holds a page slug is moved by the repair or exempt with a reason', () => {
  test('a new slug-keyed table cannot be missed silently', async () => {
    const { SLUG_COLUMNS_MOVED, SLUG_COLUMNS_EXEMPT } = await import('../src/core/repair/slug-spelling.ts');
    const found = await engine.executeRaw<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'
         AND (column_name ILIKE '%slug%' OR (table_name IN ('fact_withdrawals','fact_purges','take_purges','decide_review_proposals') AND column_name='subject')
              OR (table_name='wake_subscriptions' AND column_name='target'))
       ORDER BY 1, 2`);
    const columns = found.map(r => `${r.table_name}.${r.column_name}`);
    const moved = new Set<string>(SLUG_COLUMNS_MOVED);
    const exempt = SLUG_COLUMNS_EXEMPT as Record<string, string>;
    const unclassified = columns.filter(column => !moved.has(column) && !(column in exempt));
    expect(unclassified).toEqual([]);
    // Nothing is both, every exemption says why, and neither list names a column the schema no longer has.
    expect([...moved].filter(column => column in exempt)).toEqual([]);
    expect(Object.entries(exempt).filter(([, reason]) => reason.trim().length < 10).map(([column]) => column)).toEqual([]);
    expect([...moved, ...Object.keys(exempt)].filter(column => !columns.includes(column))).toEqual([]);
    expect(columns.length).toBeGreaterThan(10);
  });
});
