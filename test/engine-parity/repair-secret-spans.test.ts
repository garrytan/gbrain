/**
 * BrainEngine parity — batch 6c: `gbrain repair secret-spans` and the secret store behind it (secret-store/store.ts,
 * restore.ts, spool.ts, repair/secret-spans.ts; their statements are typed members in engine-sql/secret-store.ts,
 * engine-sql/secret-spans-rows.ts and engine-sql/page-projection-queue.ts, served on the Rust store by
 * secret_store.rs and repair_secret_spans.rs).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1) the preview of a page whose
 *    stored copies hold credentials lists it by rule with its retained versions, counts a clean page, and writes nothing;
 *    the apply with the preview hash rewrites only the spans in the page, its frontmatter, timeline rows, facts, takes,
 *    link contexts and raw data, deletes the chunk rows that held a value, keeps the stored tier, seals each original in
 *    the store with one occurrence per changed field, and a second preview is empty. A page edited after the preview
 *    stops the apply (`preview_changed`) and writes nothing. `gbrain secrets restore` puts a false positive back and marks
 *    its entry allowed, and the redactors leave the value alone afterwards. The store members seal, list, count, back up,
 *    restore, and cascade the way the SQL engines do: a purged page takes its originals with it, a renamed page takes its
 *    occurrences, a deleted source takes its entries.
 *  - Regression: every one of these statements ran through `executeRaw`, which a Rust brain refuses; `repair secret-spans`
 *    stopped at plan entry ("repair secret-spans scan") on the Rust engine.
 *  - Why existing coverage misses it: test/repair-secret-spans.test.ts, test/secret-store*.test.ts run on PGLite (and
 *    Postgres) and seed through raw SQL.
 *  - Seam: none. The repair runs in the engine's own transactions; seeding uses typed members only. Row ids, revisions
 *    and sealed ids differ by engine and are normalized (`REV`, `#`, a rule marker without its id).
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { allowedMatcher, countsByRule, entryRow, insertBackupRows, isAllowed, keysInUse, listEntries, markerOf, occurrencesOf, recordOccurrence, seal, sealWithId,
  storeSnapshot, unreferencedEntryCount } from '../../src/core/secret-store/store.ts';
import { applyRestore, previewRestore } from '../../src/core/secret-store/restore.ts';

const { parityTest } = parityArms(testBackends());

const logger = { info() {}, warn() {}, error() {} } as never;
// Obviously fake key shapes, assembled so no literal key sits in the source.
const OPENAI = ['sk', 'proj', 'EXAMPLExNOTxREALxEXAMPLExNOTxREAL'].join('-');
const AWS = 'AKIA' + 'EXAMPLENOTREAL00';
const GITHUB = 'ghp' + '_' + 'EXAMPLEnotREAL'.repeat(3);
const BEARER = 'EXAMPLEtokenNOTreal' + '1234567890abcdef';
const SECRETS = [OPENAI, AWS, GITHUB, BEARER];
const SRC = 'default';
const ALPHA = 'notes/alpha-example';
const CLEAN = 'notes/clean-example';
const ALPHA_BODY = ['# Alpha Example', '', `The deploy notes keep the old key ${OPENAI} here.`, `Authorization: Bearer ${BEARER}`,
  `The token ${BEARER} appears again bare.`, 'Nothing else changes, not even this line.'].join('\n');
const ALPHA_TIMELINE = `- **2024-01-02** | import — Rotated ${AWS} out of the build`;

/** The text with row ids, revisions and sealed ids made comparable across engines. */
const norm = <T,>(value: T): T => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v)
  .replace(/\(revision [0-9a-f-]{36}\)/g, '(revision REV)')
  .replace(/<REDACTED:([a-z0-9_]+):ss_[0-9a-f]{12}>/g, '<REDACTED:$1>')
  .replace(/ss_[0-9a-f]{12}/g, 'ss_ID')
  .replace(/(timeline_entries|facts|takes|links|raw_data)\/\d+\//g, '$1/#/'));
const leaked = (value: unknown) => SECRETS.filter(secret => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v).includes(secret));

/** Runs `body` with a fresh secret store key home, so the seal needs no key of the host. */
async function inHome<T>(body: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-secret-spans-'));
  try { return await withEnv({ GBRAIN_HOME: home, GBRAIN_SECRET_STORE_KEY: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, body); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

/** A page whose every stored copy holds a credential, a page with one in a chunk only, and a clean page. */
async function seedPages(engine: BrainEngine) {
  const alpha = await engine.putPage(ALPHA, { type: 'note' as never, title: 'Alpha Example', compiled_truth: ALPHA_BODY, timeline: ALPHA_TIMELINE,
    frontmatter: { owner: 'alice-example', note_key: `copy of ${OPENAI}` } }, { sourceId: SRC });
  const clean = await engine.putPage(CLEAN, { type: 'note' as never, title: 'Clean Example', compiled_truth: 'No credentials on this page.', timeline: '' }, { sourceId: SRC });
  // A retained version of the page as it was written, credentials and all.
  await engine.createVersion(ALPHA, { sourceId: SRC });
  await engine.addTimelineEntry(ALPHA, { date: '2024-01-02', source: 'import', summary: `Rotated ${AWS} out of the build`, detail: '' }, { sourceId: SRC });
  await engine.addTimelineEntry(ALPHA, { date: '2024-03-04', source: 'import', summary: 'Unrelated entry', detail: '' }, { sourceId: SRC });
  await engine.insertFact({ fact: `The CI token is ${GITHUB}.`, entity_slug: ALPHA, visibility: 'world', context: `Seen next to ${AWS} in the notes`, source: 'test', embedding: null }, { source_id: SRC });
  await engine.addTakesBatch([{ page_id: Number(alpha.id), row_num: 1, claim: `Rotating ${OPENAI} was overdue`, kind: 'take', holder: 'alice-example', source: 'notes' }]);
  await engine.addLink(ALPHA, CLEAN, `see ${AWS} near the clean page`, 'mentions');
  await engine.putRawData(ALPHA, 'test', { request: { headers: { authorization: `Bearer ${BEARER}` }, ids: [1, 2] }, note: 'kept as is' }, { sourceId: SRC });
  await engine.upsertChunks(ALPHA, [{ chunk_index: 0, chunk_text: ALPHA_BODY, chunk_source: 'compiled_truth' }, { chunk_index: 1, chunk_text: 'A clean chunk.', chunk_source: 'compiled_truth' }], { sourceId: SRC });
  return { alpha: Number(alpha.id), clean: Number(clean.id) };
}

const runKind = async (engine: BrainEngine, opts: { apply: boolean; slugs: string[]; expect?: string }) =>
  (await repairRunner(engine, { apply: opts.apply, noEmbed: true, logger })).run('secret-spans', await resolveRepairScope(engine, SRC),
    { explicit: true, remote: false, sourceFlag: SRC, slugs: opts.slugs, ...(opts.expect ? { expect: opts.expect } : {}) } as never);

/** Every stored copy of the alpha page and what the store holds, as the repair leaves them. */
async function readState(engine: BrainEngine) {
  const chunks = (await engine.getChunks(ALPHA, { sourceId: SRC, includeUnsealed: true } as never)).map(c => c.chunk_text);
  const page = await engine.getPage(ALPHA, { sourceId: SRC });
  const snapshot = await engine.readPageSnapshot(ALPHA, { sourceId: SRC });
  return norm({
    page: { title: page!.title, compiled_truth: page!.compiled_truth, timeline: page!.timeline, frontmatter: page!.frontmatter },
    timeline: (await engine.getTimeline(ALPHA, { sourceId: SRC } as never)).map(e => [e.date, e.summary]).sort(),
    facts: (await engine.listFactsByEntity(SRC, ALPHA, { activeOnly: false } as never)).map(f => [f.fact, f.context]),
    takes: (await engine.listTakes({ page_slug: ALPHA } as never)).map(t => [t.claim, t.source]),
    links: (await engine.getLinks(ALPHA, { sourceId: SRC } as never)).map(l => l.context),
    raw: (await engine.getRawData(ALPHA, 'test', { sourceId: SRC })).map(r => r.data),
    revision: snapshot!.revision,
    chunksHoldingACredential: leaked(chunks).length,
  });
}

describe('engine parity: repair secret-spans', () => {
  parityTest('the preview lists a page with credentials by rule, counts a clean page and writes nothing', {
    methods: ['putPage', 'createVersion', 'addTimelineEntry', 'insertFact', 'addTakesBatch', 'addLink', 'putRawData', 'upsertChunks', 'getPage',
      'readPageRedactionRow', 'readPageRedactionRows', 'listTimelineDedupRows', 'countPageVersionRows', 'listAllowedSecretMacs'],
    timeout: 120_000,
  }, async engine => {
    await seedPages(engine);
    return inHome(async () => {
      const before = await readState(engine);
      const preview = await runKind(engine, { apply: false, slugs: [ALPHA, CLEAN, 'notes/missing-example'] });
      expect(preview.affected).toBe(1);
      expect(preview.residuals).toMatchObject({ pages_to_redact: 1, clean: 1, refused: 1 });
      expect(leaked(preview)).toEqual([]);
      expect(await readState(engine)).toEqual(before);
      return norm({ affected: preview.affected, residuals: preview.residuals, listing: preview.listing, rules: (preview.details as { rules: string[] }).rules,
        fields: ((preview.details as { pages: Array<{ fields: Array<{ key: string; spans: number }>; rules: unknown; versions: number }> }).pages)
          .map(page => ({ rules: page.rules, versions: page.versions, fields: page.fields.map(f => [f.key, f.spans]) })) });
    });
  });

  parityTest('the apply with the preview hash rewrites only the spans, seals each original and leaves a second preview empty', {
    methods: ['putPage', 'createVersion', 'getVersions', 'addTimelineEntry', 'insertFact', 'addTakesBatch', 'addLink', 'putRawData', 'upsertChunks', 'getPage', 'readPageSnapshot', 'getTimeline',
      'listFactsByEntity', 'listTakes', 'getLinks', 'getRawData', 'getChunks', 'readPageRedactionRow', 'readPageRedactionRows', 'listTimelineDedupRows',
      'listVersionBodiesForRedaction', 'setRetainedVersionBody', 'listChunkTextsForRedaction', 'deleteChunksByIds', 'setRedactedPageFields', 'readRawDataValue', 'setRawDataValue', 'setRedactedRowText',
      'queuePageProjectionJob', 'findSecretEntryByMac', 'insertSecretEntry', 'insertSecretOccurrence', 'listSecretEntrySummaries', 'countSecretsByRule',
      'listSecretOccurrences', 'readSecretEntry', 'readOpCheckpointRecord', 'writeOpCheckpointRecord', 'readPageRevisions'],
    timeout: 180_000,
  }, async (engine, backend) => {
    await seedPages(engine);
    return inHome(async () => {
      const slugs = [ALPHA, CLEAN];
      const before = await readState(engine);
      const preview = await runKind(engine, { apply: false, slugs });
      const result = await runKind(engine, { apply: true, slugs, expect: preview.preview_hash });
      expect(result.applied).toBe(1);
      expect(result.outcomes).toEqual({ redacted: 1 });
      // The immediate reseal is raw SQL: the Rust engine leaves the page's projection queued for the queue's own rebuild.
      expect((result.outcome_items ?? []).map(item => item.detail?.projection)).toEqual([backend === 'rust' ? 'queued' : 'sealed']);
      expect(leaked(result)).toEqual([]);
      const after = await readState(engine);
      expect(after.revision).not.toBe(before.revision);
      expect(leaked(after)).toEqual([]);
      const entries = await engine.listSecretEntrySummaries({ sourceId: SRC, slug: null, limit: 100 });
      const occurrences = [];
      for (const entry of entries) occurrences.push(await engine.listSecretOccurrences(entry.id));
      const read = await engine.readSecretEntry(entries.find(e => e.rule === 'openai')!.id);
      const again = await runKind(engine, { apply: false, slugs });
      return norm({ result: { applied: result.applied, outcomes: result.outcomes, verification: result.verification,
        items: (result.outcome_items ?? []).map(item => ({ item: item.item, outcome: item.outcome, detail: { ...item.detail, projection: undefined } })) },
      state: { ...after, revision: undefined }, entries: entries.map(e => ({ rule: e.rule, status: e.status, occurrences: e.occurrences, slugs: e.slugs }))
        .sort((a, b) => a.rule.localeCompare(b.rule)),
      entry: { rule: read!.rule, status: read!.status, source_id: read!.source_id, readable: /^[0-9a-f]{16}$/.test(read!.key_id) },
      versions: (await engine.getVersions(ALPHA, { sourceId: SRC, includeBody: true } as never)).map(v => v.compiled_truth),
      places: occurrences.map(list => list.map(o => [o.slug, o.field, o.origin]).sort()).sort(),
      byRule: await engine.countSecretsByRule(SRC), second: { affected: again.affected, residuals: again.residuals } });
    });
  });

  parityTest('a page edited after the preview stops the apply and nothing is written', {
    methods: ['putPage', 'readPageSnapshot', 'getPage', 'getTimeline', 'listFactsByEntity', 'listTakes', 'getLinks', 'getRawData', 'getChunks', 'listSecretEntrySummaries'],
    timeout: 120_000,
  }, async engine => {
    await seedPages(engine);
    return inHome(async () => {
      const slugs = [ALPHA, CLEAN];
      const preview = await runKind(engine, { apply: false, slugs });
      await engine.putPage(ALPHA, { type: 'note' as never, title: 'Alpha Example', compiled_truth: `${ALPHA_BODY}\nA later edit.`, timeline: ALPHA_TIMELINE,
        frontmatter: { owner: 'alice-example', note_key: `copy of ${OPENAI}` } }, { sourceId: SRC });
      const before = await readState(engine);
      let code: unknown = null;
      try { await runKind(engine, { apply: true, slugs, expect: preview.preview_hash }); } catch (error) { code = (error as { code?: string }).code; }
      expect(code).toBe('preview_changed');
      expect(await readState(engine)).toEqual(before);
      return { code, entries: (await engine.listSecretEntrySummaries({ sourceId: SRC, slug: null, limit: 100 })).length };
    });
  });

  parityTest('gbrain secrets restore puts a false positive back, marks its entry allowed and the redactor leaves it alone', {
    methods: ['putPage', 'insertFact', 'addTimelineEntry', 'addTakesBatch', 'addLink', 'putRawData', 'upsertChunks', 'getPage', 'readPageSnapshot', 'createVersion',
      'listSecretEntrySummaries', 'readSecretEntry', 'listSecretOccurrences', 'readRestorePageHit', 'markSecretEntryAllowed', 'listAllowedSecretMacs', 'getTimeline',
      'listFactsByEntity', 'listTakes', 'getLinks', 'getRawData', 'getChunks'],
    timeout: 120_000,
  }, async engine => {
    await seedPages(engine);
    return inHome(async () => {
      const slugs = [ALPHA, CLEAN];
      const preview = await runKind(engine, { apply: false, slugs });
      await runKind(engine, { apply: true, slugs, expect: preview.preview_hash });
      const entry = (await engine.listSecretEntrySummaries({ sourceId: SRC, slug: null, limit: 100 })).find(e => e.rule === 'openai')!;
      const restore = await previewRestore(engine, entry.id);
      expect(restore.pages.map(p => p.slug)).toEqual([ALPHA]);
      const done = await applyRestore(engine, entry.id, restore.hash, 'parity-test');
      const after = await readState(engine);
      expect(JSON.stringify(after)).toContain(OPENAI);
      const second = await runKind(engine, { apply: false, slugs });
      return norm({ fields: restore.pages.map(p => p.fields), restored: done.restored, status: done.status, entry: (await engine.readSecretEntry(entry.id))!.status,
        allowed: (await allowedMatcher(engine, SRC))(OPENAI), other: (await allowedMatcher(engine, SRC))(AWS), isAllowed: await isAllowed(engine, SRC, OPENAI),
        // The chunk rows are rebuilt from the restored body right away on the SQL engines and by the projection queue on the Rust engine.
        state: { ...after, revision: undefined, chunksHoldingACredential: undefined }, second: { affected: second.affected, residuals: second.residuals } });
    });
  });

  parityTest('the store seals one entry per value, lists it with its places, counts by rule and keeps restored values apart', {
    methods: ['putPage', 'findSecretEntryByMac', 'secretEntryExists', 'insertSecretEntry', 'insertSecretOccurrence', 'readSecretEntry', 'listSecretOccurrences', 'listSecretEntrySummaries',
      'countSecretsByRule', 'listAllowedSecretMacs', 'listSecretKeysInUse', 'countUnreferencedSecretEntries', 'markSecretEntryAllowed', 'deleteUnreferencedSecretEntry'],
    timeout: 120_000,
  }, async engine => {
    const page = await engine.putPage('notes/store-a', { type: 'note' as never, title: 'Store A', compiled_truth: 'Body.', timeline: '' }, { sourceId: SRC });
    return inHome(async () => {
      const first = await seal(engine, { sourceId: SRC, rule: 'github_token', value: GITHUB });
      const again = await seal(engine, { sourceId: SRC, rule: 'github_token', value: GITHUB });
      expect(again).toMatchObject({ id: first.id, created: false });
      const other = await seal(engine, { sourceId: SRC, rule: 'aws_access_key', value: AWS });
      await recordOccurrence(engine, { entryId: first.id, sourceId: SRC, pageId: Number(page.id), slug: 'notes/store-a', field: 'compiled_truth', origin: 'repair', createdBy: 'test' });
      await recordOccurrence(engine, { entryId: first.id, sourceId: SRC, slug: 'notes/store-b', field: 'title', origin: 'transcript' });
      await recordOccurrence(engine, { entryId: other.id, sourceId: SRC, field: 'compiled_truth', origin: 'publish_rebuild', commit: 'abc123', path: 'notes/c.md', line: 7 });
      const spool = await sealWithId(engine, { id: 'ss_0123456789ab', sourceId: SRC, rule: 'openai', value: OPENAI });
      const spoolAgain = await sealWithId(engine, { id: 'ss_0123456789ab', sourceId: SRC, rule: 'openai', value: OPENAI });
      const spoolDuplicate = await sealWithId(engine, { id: 'ss_ba9876543210', sourceId: SRC, rule: 'openai', value: OPENAI });
      expect(spool).toEqual({ kind: 'inserted' });
      expect(spoolAgain).toEqual({ kind: 'exists' });
      expect(spoolDuplicate).toEqual({ kind: 'duplicate', existing: 'ss_0123456789ab' });
      // A row the CHECKs or the foreign keys refuse is refused on every engine, and nothing is written.
      const refused = async (run: () => Promise<unknown>) => run().then(() => false, () => true);
      const refusals = {
        badRule: await refused(() => engine.insertSecretEntry({ id: 'ss_aaaaaaaaaaaa', sourceId: SRC, rule: 'Bad Rule', ciphertext: 'c', nonce: 'n', tag: 't', keyId: '0123456789abcdef', keyHost: '', valueMac: 'a'.repeat(64) }, 'value')),
        unknownSource: await refused(() => engine.insertSecretEntry({ id: 'ss_bbbbbbbbbbbb', sourceId: 'nowhere', rule: 'r', ciphertext: 'c', nonce: 'n', tag: 't', keyId: '0123456789abcdef', keyHost: '', valueMac: 'b'.repeat(64) }, 'value')),
        idClash: await refused(() => engine.insertSecretEntry({ id: first.id, sourceId: SRC, rule: 'r', ciphertext: 'c', nonce: 'n', tag: 't', keyId: '0123456789abcdef', keyHost: '', valueMac: 'c'.repeat(64) }, 'value')),
        unknownEntry: await refused(() => recordOccurrence(engine, { entryId: 'ss_cccccccccccc', sourceId: SRC, field: 'title', origin: 'repair' })),
        badOrigin: await refused(() => recordOccurrence(engine, { entryId: first.id, sourceId: SRC, field: 'title', origin: 'nowhere' as never })),
        invalidId: await refused(() => entryRow(engine, 'not-an-id')),
        missing: await refused(() => entryRow(engine, 'ss_dddddddddddd')),
      };
      expect(Object.values(refusals)).toEqual(Array(7).fill(true));
      await engine.markSecretEntryAllowed(spool.kind === 'inserted' ? 'ss_0123456789ab' : first.id);
      const summaries = await listEntries(engine, { sourceId: SRC });
      const atSlug = await listEntries(engine, { slug: 'notes/store-b' });
      expect(await engine.deleteUnreferencedSecretEntry(first.id)).toBe(false);
      const unreferenced = await seal(engine, { sourceId: SRC, rule: 'bearer', value: BEARER });
      const before = await unreferencedEntryCount(engine);
      expect(await engine.deleteUnreferencedSecretEntry(unreferenced.id)).toBe(true);
      return norm({
        created: [first.created, other.created, again.created], found: await engine.findSecretEntryByMac(SRC, 'f'.repeat(64)),
        summaries: summaries.map(e => ({ rule: e.rule, status: e.status, occurrences: e.occurrences, slugs: e.slugs, readable: e.readable })).sort((a, b) => a.rule.localeCompare(b.rule)),
        atSlug: atSlug.map(e => e.rule), counts: await countsByRule(engine), sourceCounts: await countsByRule(engine, 'nowhere'),
        keys: (await keysInUse(engine)).map(k => k.entries), allowed: (await engine.listAllowedSecretMacs(SRC)).length, allowedEverywhere: (await engine.listAllowedSecretMacs(null)).length,
        places: (await occurrencesOf(engine, first.id)).map(o => [o.slug, o.field, o.origin, o.page_id === null ? null : 'page']),
        commitPlace: (await occurrencesOf(engine, other.id)).map(o => [o.commit_sha, o.path, o.line]), exists: await engine.secretEntryExists(first.id),
        entry: { rule: (await entryRow(engine, first.id)).rule, status: (await entryRow(engine, first.id)).status }, unreferenced: [before, await unreferencedEntryCount(engine)],
        marker: markerOf('github_token', first.id).replace(first.id, 'ID'), refusals,
      });
    });
  });

  parityTest('a purge takes the originals only that page held, a rename moves its places, a source delete takes its entries, and a backup restores by page', {
    methods: ['putPage', 'updateSlug', 'deletePages', 'softDeletePages', 'purgeDeletedPages', 'deleteSourceRecord', 'readSecretStoreSnapshot', 'insertBackupSecretEntry',
      'readBackupEntryHold', 'insertBackupSecretOccurrence', 'deleteUnreferencedSecretEntry', 'listSecretHoldingPages', 'listSecretOccurrences', 'readSecretEntry',
      'countUnreferencedSecretEntries', 'listSecretEntrySummaries', 'countSecretsByRule'],
    timeout: 120_000,
  }, async (engine, backend) => {
    const note = (slug: string, text = 'Body.') => ({ type: 'note' as never, title: slug, compiled_truth: text, timeline: '' });
    const pageA = await engine.putPage('notes/purge-a', note('notes/purge-a'), { sourceId: SRC });
    const pageB = await engine.putPage('notes/purge-b', note('notes/purge-b'), { sourceId: SRC });
    await createSource(engine, backend, 'doomed', {});
    const pageD = await engine.putPage('notes/doomed-a', note('notes/doomed-a'), { sourceId: 'doomed' });
    return inHome(async () => {
      const e1 = await seal(engine, { sourceId: SRC, rule: 'github_token', value: GITHUB });
      const e2 = await seal(engine, { sourceId: SRC, rule: 'aws_access_key', value: AWS });
      const e3 = await seal(engine, { sourceId: SRC, rule: 'openai', value: OPENAI });
      const e4 = await seal(engine, { sourceId: 'doomed', rule: 'bearer', value: BEARER });
      const on = (entry: { id: string }, page: { id: number | string; slug: string }, sourceId = SRC) =>
        recordOccurrence(engine, { entryId: entry.id, sourceId, pageId: Number(page.id), slug: page.slug, field: 'compiled_truth', origin: 'repair' });
      await on(e1, pageA); await on(e2, pageA); await on(e2, pageB); await on(e4, pageD, 'doomed');
      await recordOccurrence(engine, { entryId: e3.id, sourceId: SRC, field: 'compiled_truth', origin: 'publish_rebuild', commit: 'abc123', path: 'notes/c.md', line: 3 });
      const snapshot = await storeSnapshot(engine);
      const places = async (entry: { id: string }) => (await occurrencesOf(engine, entry.id)).map(o => [o.slug, o.page_id === null ? null : 'page', o.commit_sha]);
      const steps: Record<string, unknown> = { snapshot: snapshot.entries.length * 10 + snapshot.occurrences.length };
      // A rename takes the page's places with it; a commit place stays.
      await engine.updateSlug('notes/purge-b', 'notes/purge-c', { sourceId: SRC });
      steps.renamed = await places(e2);
      // A hard delete takes the originals only that page held; e2 keeps its other place.
      await engine.deletePages(['notes/purge-a'], { sourceId: SRC });
      steps.afterDelete = { e1: await engine.readSecretEntry(e1.id) === null, e2: await places(e2), e3: await places(e3) };
      // A tombstone purge takes the rest of e2.
      await engine.softDeletePages(['notes/purge-c'], { sourceId: SRC });
      await engine.purgeDeletedPages(0, {});
      steps.afterPurge = { e2: await engine.readSecretEntry(e2.id) === null, e3: await engine.readSecretEntry(e3.id) !== null, unreferenced: await unreferencedEntryCount(engine) };
      // A source delete takes its entries with their places.
      await engine.deleteSourceRecord('doomed');
      steps.afterSourceDelete = { e4: await engine.readSecretEntry(e4.id) === null, others: (await listEntries(engine, {})).map(e => e.rule).sort() };

      // The backup restores an entry only while a page of its source holds the marker; a commit place needs no page.
      const holder = await engine.putPage('notes/purge-a', note('notes/purge-a', `kept ${markerOf('github_token', e1.id)} and ${markerOf('aws_access_key', e2.id)} here`), { sourceId: SRC });
      const entries = snapshot.entries.filter(e => e.source_id === SRC);
      const mine = new Set(entries.map(e => e.id));
      const occurrences = snapshot.occurrences.filter(o => mine.has(o.entry_id));
      steps.holders = (await engine.listSecretHoldingPages(SRC, ['notes/purge-a', 'notes/purge-c', 'notes/never'], e2.id)).map(p => [p.slug, p.holds, p.segmented]);
      steps.restored = await insertBackupRows(engine, entries, occurrences);
      steps.restoredPlaces = { e1: await places(e1), e2: await places(e2), e3: await places(e3) };
      steps.again = await insertBackupRows(engine, entries, occurrences);
      // With the page gone again, an entry recorded only on pages is not brought back.
      await engine.deletePages(['notes/purge-a'], { sourceId: SRC });
      expect(holder.slug).toBe('notes/purge-a');
      steps.counts = await countsByRule(engine, SRC);
      steps.skipped = await insertBackupRows(engine, entries.filter(e => e.id === e1.id), occurrences.filter(o => o.entry_id === e1.id));
      return norm(steps);
    });
  });

  parityTest('the page-store members answer the same when called directly: reads, rewrites, versions, chunks and the queue', {
    methods: ['putPage', 'createVersion', 'addTimelineEntry', 'insertFact', 'addTakesBatch', 'addLink', 'putRawData', 'upsertChunks', 'getPage',
      'readPageRedactionRow', 'readPageRedactionRows', 'listTimelineDedupRows', 'listVersionBodiesForRedaction', 'countPageVersionRows', 'setRetainedVersionBody',
      'listChunkTextsForRedaction', 'deleteChunksByIds', 'setRedactedPageFields', 'readRawDataValue', 'setRawDataValue', 'setRedactedRowText', 'queuePageProjectionJob',
      'readPageSnapshot'],
    timeout: 120_000,
  }, async engine => {
    const { alpha } = await seedPages(engine);
    await engine.putPage(ALPHA, { type: 'note' as never, title: 'Alpha Example', compiled_truth: `${ALPHA_BODY} (edited)`, timeline: ALPHA_TIMELINE,
      frontmatter: { owner: 'alice-example', note_key: `copy of ${OPENAI}` } }, { sourceId: SRC });
    await engine.createVersion(ALPHA, { sourceId: SRC });
    const row = await engine.readPageRedactionRow(SRC, ALPHA);
    expect(row).toMatchObject({ id: alpha, title: 'Alpha Example', body_storage: 'inline', generation: '0', tags: [] });
    expect(await engine.readPageRedactionRow(SRC, 'notes/missing')).toBeNull();
    const rows = await engine.readPageRedactionRows(alpha, SRC, ALPHA);
    const timelineBefore = (await engine.listTimelineDedupRows(alpha)).map(r => [r.date, r.summary, r.source]);
    const versions = await engine.listVersionBodiesForRedaction(alpha);
    expect(await engine.countPageVersionRows(alpha)).toBe(versions.length);
    // Rewrites: the page, a timeline row, a fact, a take, a link, a raw data row, a retained version and a chunk row.
    await engine.setRedactedPageFields(alpha, { title: 'Alpha Example', frontmatter: { owner: 'alice-example', note_key: 'copy of [x]' }, compiledTruth: 'redacted body', timeline: ALPHA_TIMELINE, contentHash: 'hash-1' });
    await engine.setRedactedRowText(alpha, 'timeline_entries', rows.timeline[0]!.id, 'summary', 'Rotated [x] out of the build');
    await engine.setRedactedRowText(alpha, 'facts', rows.facts[0]!.id, 'fact', 'The CI token is [x].');
    await engine.setRedactedRowText(alpha, 'takes', rows.takes[0]!.id, 'claim', 'Rotating [x] was overdue');
    await engine.setRedactedRowText(alpha, 'links', rows.links[0]!.id, 'context', 'see [x] near the clean page');
    const rawId = rows.rawData[0]!.id;
    expect(await engine.readRawDataValue(alpha, rawId)).toEqual(rows.rawData[0]!.data);
    await engine.setRawDataValue(alpha, rawId, { request: { headers: { authorization: 'Bearer [x]' }, ids: [1, 2] }, note: 'kept as is' });
    await engine.setRetainedVersionBody(alpha, versions[0]!.id, 'retained [x]', { owner: 'alice-example' });
    const chunks = await engine.listChunkTextsForRedaction(alpha, 'rewrite');
    const doomed = chunks.filter(c => c.chunk_text.includes(OPENAI)).map(c => Number(c.id));
    await engine.deleteChunksByIds(alpha, doomed);
    await engine.queuePageProjectionJob(SRC, ALPHA, 'secret_spans');
    await engine.queuePageProjectionJob(SRC, 'notes/missing', 'secret_spans');
    const after = await engine.readPageRedactionRows(alpha, SRC, ALPHA);
    const snapshot = await engine.readPageSnapshot(ALPHA, { sourceId: SRC });
    expect(await engine.listChunkTextsForRedaction(alpha, 'scan')).toHaveLength(chunks.length - doomed.length);
    return norm({
      row: { ...row, id: undefined, revision: undefined }, timelineBefore, versions: versions.map(v => [v.compiled_truth, v.body_storage]),
      doomed: doomed.length, chunksLeft: (await engine.listChunkTextsForRedaction(alpha, 'scan')).map(c => c.chunk_text),
      after: { timeline: after.timeline.map(t => t.summary), facts: after.facts.map(f => f.fact), takes: after.takes.map(t => t.claim), links: after.links.map(l => l.context),
        raw: after.rawData.map(r => r.data) },
      retained: (await engine.listVersionBodiesForRedaction(alpha)).map(v => [v.compiled_truth, v.frontmatter]),
      page: { hash: (await engine.getPage(ALPHA, { sourceId: SRC }))!.compiled_truth, revisionMoved: snapshot!.revision !== row!.revision },
    });
  });

  parityTest('the store members read what they wrote: occurrences, keys, a backup row, a restore hit and the unreferenced count', {
    methods: ['putPage', 'insertSecretEntry', 'insertSecretOccurrence', 'listSecretKeysInUse', 'insertBackupSecretEntry', 'readBackupEntryHold', 'insertBackupSecretOccurrence',
      'countUnreferencedSecretEntries', 'readRestorePageHit', 'readSecretEntry', 'listSecretOccurrences', 'readPageSnapshot', 'deletePages'],
    timeout: 120_000,
  }, async engine => {
    const page = await engine.putPage('notes/direct', { type: 'note' as never, title: 'Direct', compiled_truth: `holds ${markerOf('github_token', 'ss_0123456789ab')}`, timeline: '' }, { sourceId: SRC });
    const base = { ciphertext: 'Y2lwaGVy', nonce: 'bm9uY2U=', tag: 'dGFn', keyId: '0123456789abcdef', keyHost: 'host-a' };
    const first = await engine.insertSecretEntry({ id: 'ss_0123456789ab', sourceId: SRC, rule: 'github_token', valueMac: 'a'.repeat(64), ...base }, 'value');
    const clash = await engine.insertSecretEntry({ id: 'ss_ba9876543210', sourceId: SRC, rule: 'github_token', valueMac: 'a'.repeat(64), ...base }, 'any');
    await engine.insertSecretOccurrence({ entryId: 'ss_0123456789ab', sourceId: SRC, pageId: Number(page.id), slug: 'notes/direct', field: 'compiled_truth', origin: 'repair',
      commit: null, path: null, line: null, preFieldSha256: null, createdBy: 'test' });
    const entry = (await engine.readSecretEntry('ss_0123456789ab'))!;
    const backup = { ...entry, updated_at: '2026-11-21T11:00:00.456Z', id: 'ss_aaaaaaaaaaaa', value_mac: 'b'.repeat(64), status: 'allowed' as const, created_at: '2026-11-21T10:00:00.123Z' };
    const written = [await engine.insertBackupSecretEntry(backup), await engine.insertBackupSecretEntry(backup)];
    const place = { entry_id: backup.id, source_id: SRC, page_id: null, slug: 'notes/direct', field: 'compiled_truth', origin: 'repair' as const, commit_sha: null, path: null, line: null,
      pre_field_sha256: null, created_by: 't', created_at: '2026-11-21T10:00:00.789Z' };
    const placed = [await engine.insertBackupSecretOccurrence(place, null), await engine.insertBackupSecretOccurrence(place, Number(page.id)), await engine.insertBackupSecretOccurrence(place, Number(page.id))];
    const hold = [await engine.readBackupEntryHold(backup.id, SRC, 'b'.repeat(64)), await engine.readBackupEntryHold(backup.id, SRC, 'c'.repeat(64)), await engine.readBackupEntryHold('ss_cccccccccccc', SRC, 'b'.repeat(64))];
    const hit = await engine.readRestorePageHit(SRC, 'notes/direct', markerOf('github_token', 'ss_0123456789ab'));
    const miss = await engine.readRestorePageHit(SRC, 'notes/direct', markerOf('github_token', 'ss_bbbbbbbbbbbb'));
    const snapshot = await engine.readPageSnapshot('notes/direct', { sourceId: SRC });
    expect(hit!.revision).toBe(snapshot!.revision);
    const unreferenced = [await engine.countUnreferencedSecretEntries()];
    await engine.deletePages(['notes/direct'], { sourceId: SRC });
    unreferenced.push(await engine.countUnreferencedSecretEntries());
    return norm({ first, clash, keys: (await engine.listSecretKeysInUse()).map(k => [k.key_host, k.entries]), written, placed, hold, hit: hit!.hit, miss: miss!.hit, noPage: await engine.readRestorePageHit(SRC, 'notes/gone', 'x'),
      places: (await engine.listSecretOccurrences(backup.id)).map(o => [o.slug, o.page_id === null ? null : 'page']), unreferenced });
  });
});
