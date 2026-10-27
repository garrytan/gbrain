/**
 * A full episode admits a page that is already current without a reparse (sync-classify.ts `inPlace`): the import record
 * names the committed blob and the page's revision, the parser and chunker the record carries are this binary's, its
 * chunks, text projection and contextual mode are current (`derivedCurrent`) and no hold names it. Any other page
 * reparses exactly as before.
 *
 * Protects:
 * - classifier: an all-current page under an open episode is `matched` (it was `reparse`); a stale parser, a stale derived
 *   state, a blob the record does not name, a hold, or a force-import state (a moved origin) each keep today's class.
 * - classifier, any force-import flag: across every state below, lifting the episode's term turns a path `matched` only
 *   when the same path outside an episode is `matched`. A state that forces an import must keep a page from `matched`
 *   outside an episode to force anything, so it keeps its reparse inside one too.
 * - full pass: an all-current page gets no request and no record write (its import record stays byte-identical, so it
 *   was neither imported nor waived); a page with a stale parser, a stale chunker version, a stale contextual mode, a
 *   stale text projection, an edited committed file, a re-screen-due hold or a moved origin is re-imported (its record
 *   carries the episode). The pass converges and the episode closes as before.
 * - the links watermark is not part of `derivedCurrent` (GBRA-108): a reparse of unchanged bytes never advances
 *   `links_extracted_at` (link extraction is the sync tail's and `extract --stale`'s), so a current page whose watermark
 *   is null or older than the extractor is `matched` under a full pass and is not reparsed.
 *
 * Each test fails before this change: there every live page an open episode had not re-imported was `reparse`, so a full
 * pass re-imported (or waived) the all-current page and rewrote its import record with the episode.
 *
 * PGLite here; Postgres through test/e2e/sync-pass-episode-in-place-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { classifySyncPath, type SyncClass, type SyncPathState } from '../src/core/persistence/sync-classify.ts';
import { SYNC_IMPORT_PROVENANCE_OP, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';

const base: SyncPathState = { mode: 'committed', tree: 'A', level: 'A', present: true, dirty: 'clean', diskOid: null,
  page: { live: true, revision: 'R1', originMatches: true }, record: { blobOids: ['A'], revision: 'R1', parserSame: true },
  attested: null, levelSha256: null, published: false, hold: null, marker: null, baseline: null, spelling: false,
  episodeUnsatisfied: true, derivedCurrent: true, fullObligation: true, keepDb: false, openWork: false };
const at = (patch: Partial<SyncPathState>): SyncPathState => ({ ...base, ...patch });
const rescreenHold = { atLevel: true, rescreenDue: true, retried: false };

describe('classifier: a current page satisfies an open episode in place', () => {
  test('an all-current page is matched, with nothing to do', () => {
    expect(classifySyncPath(at({}))).toMatchObject({ cls: 'matched', settled: true, action: 'none' });
  });

  const stale: Array<[string, Partial<SyncPathState>, SyncClass]> = [
    ['a stale parser', { record: { blobOids: ['A'], revision: 'R1', parserSame: false } }, 'reparse'],
    ['a stale derived state (chunker, projection or contextual mode)', { derivedCurrent: false }, 'reparse'],
    ['an unknown derived state', { derivedCurrent: undefined }, 'reparse'],
    ['a committed blob the record does not name', { tree: 'B', level: 'B' }, 'import'],
    ['a re-screen-due hold', { hold: rescreenHold }, 'reparse'],
    ['a force-import state (the origin moved)', { page: { live: true, revision: 'R1', originMatches: false } }, 'reparse'],
  ];
  for (const [name, patch, cls] of stale) test(`${name} keeps today's class (${cls})`, () => {
    expect(classifySyncPath(at(patch)).cls).toBe(cls);
    expect(classifySyncPath(at(patch))).toEqual(classifySyncPath(at({ ...patch, derivedCurrent: false })));
  });

  test('lifting the episode turns a path matched only when the same path outside an episode is matched', () => {
    const variants: Array<Partial<SyncPathState>> = [{}, ...stale.map(([, patch]) => patch),
      { record: { blobOids: ['A'], revision: 'R0', parserSame: true } }, { hold: { atLevel: true, rescreenDue: false, retried: false } },
      { spelling: true }, { keepDb: true }, { openWork: true }, { page: { live: false, revision: 'R1', originMatches: true } },
      { attested: { hash: 'h', arm1: true }, levelSha256: 'h', tree: 'B', level: 'B' }, { mode: 'working', dirty: null }];
    for (const patch of variants) for (const strict of [false, true]) {
      const inside = classifySyncPath(at(patch), { strict }), before = classifySyncPath(at({ ...patch, derivedCurrent: false }), { strict });
      const outside = classifySyncPath(at({ ...patch, episodeUnsatisfied: false }), { strict });
      if (inside.cls !== before.cls) expect({ patch, strict, outside: outside.cls, inside: inside.cls }).toEqual({ patch, strict, outside: 'matched', inside: 'matched' });
    }
  });
});

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const CASES = ['current', 'parser', 'chunker', 'contextual', 'projection', 'edited', 'held', 'origin'] as const;
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const name of CASES) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`, `The committed body of notes/${name}.`));
  commit(root, 'notes');
};
const pageId = async (engine: BrainEngine, slug: string) => Number((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.id);
const recordOf = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ keys: string; updated_at: string; episode: string | null }>(
  `SELECT completed_keys::text AS keys, updated_at::text AS updated_at, completed_keys->0->>'full_episode' AS episode FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE '%:' || $2`,
  [SYNC_IMPORT_PROVENANCE_OP, String(await pageId(engine, slug))]))[0]!;
const requestsFor = async (engine: BrainEngine, slug: string) => Number((await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id='default' AND slug=$1", [slug]))[0]!.n);
const setRecord = (engine: BrainEngine, slug: string, path: string, value: unknown) => pageId(engine, slug).then(id => engine.executeRaw(
  `UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys, $3::text[], $4::text::jsonb) WHERE op=$1 AND fingerprint LIKE '%:' || $2`,
  [SYNC_IMPORT_PROVENANCE_OP, String(id), `{0,${path}}`, JSON.stringify(value)]));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  describe(`full pass: a current page is admitted without a reparse (${backend})`, () => {
    test('the all-current page is neither imported nor waived; every stale page is re-imported', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='default'");
      await setRecord(engine, 'notes/parser', 'parser', { parser_version: 0, markdown_chunker: 0, schema_pack: null });
      await engine.executeRaw("UPDATE pages SET chunker_version=3 WHERE source_id='default' AND slug='notes/chunker'");
      await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode=NULL WHERE source_id='default' AND slug='notes/contextual'");
      await engine.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE source_id='default' AND slug='notes/projection'");
      await setRecord(engine, 'notes/origin', 'origin', 'notes/elsewhere.md');
      writeFileSync(join(root, 'notes/edited.md'), note('notes/edited', 'An edited body of notes/edited.')); commit(root, 'edit');
      const held = (await engine.readPageSnapshot('notes/held', { sourceId: 'default' }))!;
      await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: 'notes/held.md', source_path: 'notes/held.md', slug: 'notes/held', page_id: Number(held.page.id),
        code: 'frontmatter_slug_conflict', message: 'Synthetic re-screen-due hold.', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
        meta: { recovery_version: RECOVERY_VERSION, blob_oid: git(root, 'rev-parse', 'HEAD:notes/held.md'), page_revision: held.revision } } as never));
      const before = Object.fromEntries(await Promise.all(CASES.map(async name => [name, { record: await recordOf(engine, `notes/${name}`), requests: await requestsFor(engine, `notes/${name}`) }] as const)));

      const run = await performManagedSync(engine, { ...OPTS, full: true });
      expect(run.status).toBe('synced');
      const [pass] = await engine.executeRaw<{ episode: unknown }>("SELECT completed_keys->0->'obligations'->'episode' AS episode FROM op_checkpoints WHERE op='managed-sync-pass'");
      expect(pass?.episode ?? null).toBeNull();

      const current = await recordOf(engine, 'notes/current');
      expect({ record: current, requests: await requestsFor(engine, 'notes/current') }).toEqual(before.current);
      for (const name of CASES.filter(name => name !== 'current')) {
        const after = await recordOf(engine, `notes/${name}`);
        expect({ name, episode: after.episode !== null, rewritten: after.keys !== before[name].record.keys }).toEqual({ name, episode: true, rewritten: true });
      }
      const [chunker] = await engine.executeRaw<{ v: number }>("SELECT chunker_version AS v FROM pages WHERE source_id='default' AND slug='notes/chunker'");
      expect(Number(chunker!.v)).toBeGreaterThan(3);
      expect((await engine.getPage('notes/edited', { sourceId: 'default' }))?.compiled_truth).toContain('An edited body');
      expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    }));

    test('a current page with a null or stale links watermark is matched under a full pass and not reparsed', () => brain(async ({ engine }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await engine.executeRaw("UPDATE pages SET links_extracted_at=NULL WHERE source_id='default' AND slug='notes/current'");
      await engine.executeRaw("UPDATE pages SET links_extracted_at='2000-01-01T00:00:00Z' WHERE source_id='default' AND slug='notes/parser'");
      const watermarked = ['notes/current', 'notes/parser'];
      const level = (await readShadowLevel(engine, { sourceId: 'default', full: true }))!;
      expect(Object.fromEntries(level.paths.filter(entry => watermarked.includes(entry.path.replace(/\.md$/, ''))).map(entry => [entry.path, entry.result.cls])))
        .toEqual({ 'notes/current.md': 'matched', 'notes/parser.md': 'matched' });
      const before = await Promise.all(watermarked.map(async slug => ({ record: await recordOf(engine, slug), requests: await requestsFor(engine, slug) })));
      expect((await performManagedSync(engine, { ...OPTS, full: true })).status).toBe('synced');
      expect(await Promise.all(watermarked.map(async slug => ({ record: await recordOf(engine, slug), requests: await requestsFor(engine, slug) })))).toEqual(before);
    }));

    // Generated by /ship Step 7 coverage audit (gstack), test-only.
    // Value: protects=an open full episode never admits a non-markdown or segmented page in place: it reparses even when revision, chunker and
    //   projection are current; fails_when=readPages' derived_current drops its page_kind or body_storage term; why_new=the full-pass test above
    //   covers the chunker, contextual and projection terms only; seam=none; no_claim=page kind and storage are set by SQL on synced pages, not by
    //   importing a real code file or a segmented body
    test('a code page or a segmented page is reparsed under a full pass even when its revision, chunker and projection are current', () => brain(async ({ engine }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const watched = ['notes/current.md', 'notes/contextual.md', 'notes/projection.md'];
      const classes = async (full: boolean) => Object.fromEntries((await readShadowLevel(engine, { sourceId: 'default', full }))!.paths
        .filter(entry => watched.includes(entry.path)).map(entry => [entry.path, entry.result.cls]));
      expect(await classes(true)).toEqual({ 'notes/current.md': 'matched', 'notes/contextual.md': 'matched', 'notes/projection.md': 'matched' });
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
        await tx.executeRaw("UPDATE pages SET page_kind='code' WHERE source_id='default' AND slug='notes/contextual'");
        await tx.executeRaw("UPDATE pages SET body_storage='segmented', compiled_truth=NULL, timeline=NULL, body_bytes=COALESCE(body_bytes, 1) WHERE source_id='default' AND slug='notes/projection'");
        await tx.executeRaw("UPDATE pages SET text_projection_revision=knowledge_revision WHERE source_id='default' AND slug IN ('notes/contextual', 'notes/projection')");
      }, TEST_WRITE_ATTRIBUTION));
      for (const slug of ['notes/contextual', 'notes/projection']) {
        const [{ revision }] = await engine.executeRaw<{ revision: string }>("SELECT knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug=$1", [slug]);
        await setRecord(engine, slug, 'revision', revision);
      }
      expect(await classes(false)).toEqual({ 'notes/current.md': 'matched', 'notes/contextual.md': 'matched', 'notes/projection.md': 'matched' });
      expect(await classes(true)).toEqual({ 'notes/current.md': 'matched', 'notes/contextual.md': 'reparse', 'notes/projection.md': 'reparse' });
    }));
  });
}
