/**
 * #6503: an extract_atoms item longer than `cycle.extract_atoms.max_input_chars`
 * is read in full as overlapping windows, never cut.
 *
 * Contract protected (each fails if the item were cut at the cap again, or
 * stamped before every window settled):
 *   - every window stays within the cap, is labelled "window i of n", and the
 *     item's tail reaches the model;
 *   - quotes verify inside the window the model read and their offsets index
 *     the FULL item text; atoms repeated across windows merge into one;
 *   - the completion receipt (final source_hash, page scan stamp, retirement
 *     of atoms an earlier extraction produced) lands only after ALL windows
 *     settled; a failed window leaves the item unstamped, retryable, and the
 *     retry pays only for the windows that had not settled;
 *   - an item within the cap is one call with the historical prompt and no
 *     window bookkeeping;
 *   - partial dispositions recorded by v0.60.189.0 are released and those
 *     items read in full;
 *   - the managed path publishes one completed batch over all windows.
 *
 * Every case drives the real `runPhaseExtractAtoms` with a stub model, on
 * PGLite and (with DATABASE_URL) Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { ATOM_WINDOW_OP, ATOM_WINDOW_OVERLAP_CHARS } from '../src/core/cycle/extract-atoms-windows.ts';
import { planTextWindows } from '../src/core/text-windows.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const CAP = 2_000;
const KNOB = 'cycle.extract_atoms.max_input_chars';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const HEAD_QUOTE = 'The team decided to measure every launch against clear exit criteria.';
const TAIL_QUOTE = 'The hidden decision was to ship the beta to ten design partners first.';

/** ~5,200 chars: a head decision, routine filler lines, and a decision only the tail holds. */
function longText(label: string): string {
  const filler = Array.from({ length: 70 }, (_, i) => `${label} filler line ${i}: routine status update with nothing new in it.`).join('\n');
  return `HEAD-MARK ${HEAD_QUOTE}\n${filler}\nTAIL-MARK ${TAIL_QUOTE}\n`;
}
const shortText = (label: string) => `${label}: a short page that fits under the cap and completes as before. `.repeat(20).slice(0, 1_200);
const windowCount = (text: string) => planTextWindows(text, CAP, ATOM_WINDOW_OVERLAP_CHARS).length;

type StubAtom = { title: string; body: string; source_quote?: string };
/** Answers by what the window holds: the head and tail decisions where present, plus one atom every window repeats. */
function windowAtoms(body: string): StubAtom[] {
  const atoms: StubAtom[] = [{ title: 'Routine status is noise', body: 'Most status lines carry nothing new.' }];
  if (body.includes('HEAD-MARK')) atoms.push({ title: 'Measure every launch', body: 'Exit criteria first.', source_quote: HEAD_QUOTE });
  if (body.includes('TAIL-MARK')) atoms.push({ title: 'Beta to design partners first', body: 'Ten partners before launch.', source_quote: TAIL_QUOTE });
  return atoms;
}

const bodyOf = (prompt: string) => /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(prompt)?.[1] ?? '';

function stubChat(answer: (body: string) => StubAtom[] | string = windowAtoms) {
  const calls: string[] = [];
  const chat = async (opts: ChatOpts): Promise<ChatResult> => {
    const last = opts.messages[opts.messages.length - 1];
    const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    calls.push(content);
    const out = answer(bodyOf(content));
    const text = typeof out === 'string' ? out : JSON.stringify(out.map(atom => ({ ...atom, atom_type: 'insight' })));
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { calls, chat };
}

const atomRows = (engine: BrainEngine, sourceId: string, originKey: 'source_slug' | 'source_path', origin: string) =>
  engine.executeRaw<{ slug: string; title: string; source_hash: string; deleted: boolean; fm: Record<string, unknown> }>(
    `SELECT slug, title, frontmatter->>'source_hash' AS source_hash, deleted_at IS NOT NULL AS deleted, frontmatter AS fm FROM pages
      WHERE source_id=$1 AND type='atom' AND frontmatter->>$2=$3 ORDER BY slug`, [sourceId, originKey, origin]);

const pageState = (engine: BrainEngine, sourceId: string, slug: string) =>
  engine.executeRaw<{ tombstoned: boolean; fail_count: number; partial_input_chars: number | null }>(
    `SELECT scan.tombstoned, scan.fail_count, scan.partial_input_chars FROM extract_atoms_page_state scan
      JOIN pages p ON p.id=scan.page_id AND scan.content_hash=p.content_hash WHERE p.source_id=$1 AND p.slug=$2`, [sourceId, slug]);

const bankedWindows = async (engine: BrainEngine, locator: string) => Number((await engine.executeRaw<{ n: number }>(
  `SELECT count(*)::int AS n FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'locator'=$2`, [ATOM_WINDOW_OP, locator]))[0].n);

/** An atom an earlier extraction produced from the item: another source_hash, same origin. */
async function seedEarlierAtom(engine: BrainEngine, sourceId: string, originKey: 'source_slug' | 'source_path', origin: string, slug: string, managed: boolean) {
  await engine.putPage(slug, { type: 'atom', title: 'An earlier extraction', compiled_truth: 'Recorded by an earlier extraction of this item.',
    frontmatter: { atom_type: 'insight', [originKey]: origin, source_hash: 'earlier0000cap00', dream_generated: true, ...(managed ? { managed_extraction: true } : {}) } }, { sourceId });
}

const THREE_TITLES = ['Beta to design partners first', 'Measure every launch', 'Routine status is noise'];

describe('extract_atoms reads items longer than max_input_chars as overlapping windows (#6503)', () => {
  const engines: Array<{ backend: string; engine: BrainEngine }> = [];
  let closePostgres: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    for (const backend of testBackends()) {
      if (backend === 'pglite') {
        const engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        engines.push({ backend, engine });
      } else {
        const isolated = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engines.push({ backend, engine: isolated.engine });
        closePostgres = isolated.close;
      }
    }
  }, 120_000);
  afterAll(async () => {
    for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });

  test('unmanaged page: every window within the cap, the tail read, quotes mapped to full-text offsets, repeats merged, complete after all windows', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      const sourceId = `win-page-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const slug = 'notes/long-decision';
      const content = longText('decision');
      const n = windowCount(content);
      expect(n, backend).toBeGreaterThanOrEqual(3);
      await engine.putPage(slug, { type: 'note', title: 'Long decision', compiled_truth: content, timeline: '' }, { sourceId });
      await seedEarlierAtom(engine, sourceId, 'source_slug', slug, 'atoms/earlier-decision', false);

      const first = stubChat();
      const result = await runPhaseExtractAtoms(engine, { sourceId, _chat: first.chat, _transcripts: [] });
      expect(first.calls, backend).toHaveLength(n);
      first.calls.forEach((prompt, i) => {
        expect(prompt, backend).toContain(`window ${i + 1} of ${n}`);
        expect(bodyOf(prompt).length, backend).toBeLessThanOrEqual(CAP);
      });
      expect(first.calls.some(prompt => bodyOf(prompt).includes(TAIL_QUOTE)), backend).toBe(true);
      expect(result.details, backend).toMatchObject({ input_truncated: 0, windowed_items: 1, window_calls: n, windows_reused: 0, pages_processed: 1 });

      const page = (await engine.getPage(slug, { sourceId }))!;
      const atoms = await atomRows(engine, sourceId, 'source_slug', slug);
      const live = atoms.filter(atom => !atom.deleted);
      // Three distinct atoms; the one every window repeated is written once.
      expect(live.map(atom => atom.title).sort(), backend).toEqual(THREE_TITLES);
      // Complete only now: the final hash on every atom, the earlier extraction's atom retired, the page stamped.
      expect(new Set(live.map(atom => atom.source_hash)), backend).toEqual(new Set([page.content_hash!.slice(0, 16)]));
      expect(atoms.find(atom => atom.slug === 'atoms/earlier-decision')?.deleted, backend).toBe(true);
      expect((await pageState(engine, sourceId, slug))[0], backend).toMatchObject({ tombstoned: true, partial_input_chars: null });
      // The tail quote verified inside its window; its stored offsets index the full page text.
      const tail = live.find(atom => atom.title === 'Beta to design partners first')!;
      const offset = tail.fm.source_quote_offset as [number, number];
      expect(tail.fm.source_quote_verified, backend).toBe(true);
      expect(offset[0], backend).toBe(content.indexOf(TAIL_QUOTE));
      expect(content.slice(offset[0], offset[1]), backend).toBe(TAIL_QUOTE);
      expect(tail.fm.source_quote, backend).toBe(TAIL_QUOTE);
      expect(await bankedWindows(engine, slug), backend).toBe(0);

      const second = stubChat();
      await runPhaseExtractAtoms(engine, { sourceId, _chat: second.chat, _transcripts: [] });
      expect(second.calls, backend).toHaveLength(0);
    }
  }, 120_000);

  test('a malformed window leaves the item unstamped and retryable; the retry calls the model only for the windows that had not settled', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      const sourceId = `win-fail-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const slug = 'notes/long-failure';
      const content = longText('failure');
      const n = windowCount(content);
      await engine.putPage(slug, { type: 'note', title: 'Long failure', compiled_truth: content, timeline: '' }, { sourceId });
      await seedEarlierAtom(engine, sourceId, 'source_slug', slug, 'atoms/earlier-failure', false);

      // The last window (the only one holding the tail) answers with prose, not JSON.
      const broken = stubChat(body => body.includes('TAIL-MARK') ? 'I could not find anything.' : windowAtoms(body));
      const failed = await runPhaseExtractAtoms(engine, { sourceId, _chat: broken.chat, _transcripts: [] });
      expect(broken.calls, backend).toHaveLength(n);
      expect(failed.details.malformed_outputs, backend).toBe(1);
      expect((failed.details.failures as Array<{ source: string }>)[0].source, backend).toBe(`${slug} (window ${n}/${n})`);
      expect(failed.details.pages_processed, backend).toBe(0);
      // Nothing published, nothing retired, no completion stamp; the failure counts toward the bounded streak.
      expect((await atomRows(engine, sourceId, 'source_slug', slug)).map(atom => [atom.slug, atom.deleted]), backend)
        .toEqual([['atoms/earlier-failure', false]]);
      expect((await pageState(engine, sourceId, slug))[0], backend).toMatchObject({ tombstoned: false, fail_count: 1 });
      expect(await bankedWindows(engine, slug), backend).toBe(n - 1);

      const retry = stubChat();
      const retried = await runPhaseExtractAtoms(engine, { sourceId, _chat: retry.chat, _transcripts: [] });
      expect(retry.calls, backend).toHaveLength(1);
      expect(bodyOf(retry.calls[0]), backend).toContain(TAIL_QUOTE);
      expect(retried.details, backend).toMatchObject({ window_calls: 1, windows_reused: n - 1, pages_processed: 1 });
      const page = (await engine.getPage(slug, { sourceId }))!;
      const atoms = await atomRows(engine, sourceId, 'source_slug', slug);
      expect(atoms.filter(atom => !atom.deleted).map(atom => atom.title).sort(), backend).toEqual(THREE_TITLES);
      expect(new Set(atoms.filter(atom => !atom.deleted).map(atom => atom.source_hash)), backend).toEqual(new Set([page.content_hash!.slice(0, 16)]));
      expect(atoms.find(atom => atom.slug === 'atoms/earlier-failure')?.deleted, backend).toBe(true);
      expect((await pageState(engine, sourceId, slug))[0], backend).toMatchObject({ tombstoned: true });
      expect(await bankedWindows(engine, slug), backend).toBe(0);
    }
  }, 120_000);

  test('a provider error on a window keeps the item retryable with no strike; settled windows are not paid for again', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      const sourceId = `win-throw-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const slug = 'notes/long-timeout';
      const content = longText('timeout');
      const n = windowCount(content);
      await engine.putPage(slug, { type: 'note', title: 'Long timeout', compiled_truth: content, timeline: '' }, { sourceId });
      const throwing = stubChat(body => { if (body.includes('TAIL-MARK')) throw new Error('request timed out'); return windowAtoms(body); });
      const result = await runPhaseExtractAtoms(engine, { sourceId, _chat: throwing.chat, _transcripts: [] });
      expect((result.details.failures as Array<{ error: string }>)[0].error, backend).toContain('transient');
      expect(await atomRows(engine, sourceId, 'source_slug', slug), backend).toEqual([]);
      expect(await pageState(engine, sourceId, slug), backend).toEqual([]);
      expect(await bankedWindows(engine, slug), backend).toBe(n - 1);
      const retry = stubChat();
      await runPhaseExtractAtoms(engine, { sourceId, _chat: retry.chat, _transcripts: [] });
      expect(retry.calls, backend).toHaveLength(1);
      expect((await pageState(engine, sourceId, slug))[0], backend).toMatchObject({ tombstoned: true });
    }
  }, 120_000);

  test('unmanaged transcript: windows over the paste-stripped text, the tail read, completed on the full hash', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      const sourceId = `win-transcript-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const filePath = `/corpus/${sourceId}/session.txt`;
      const content = `[user]\nKeep this: <pasted_content id="1">\n${'x'.repeat(5_000)}\n</pasted_content>\n${longText('session')}`;
      const transcripts = [{ filePath, content, contentHash: sha(content) }];
      await seedEarlierAtom(engine, sourceId, 'source_path', filePath, 'atoms/earlier-session', false);
      const first = stubChat();
      const result = await runPhaseExtractAtoms(engine, { sourceId, _chat: first.chat, _transcripts: transcripts, _pages: [] });
      expect(first.calls.length, backend).toBeGreaterThanOrEqual(3);
      expect(first.calls.some(prompt => prompt.includes('x'.repeat(100))), backend).toBe(false);
      expect(first.calls.some(prompt => bodyOf(prompt).includes(TAIL_QUOTE)), backend).toBe(true);
      expect(result.details.transcripts_processed, backend).toBe(1);
      const atoms = await atomRows(engine, sourceId, 'source_path', filePath);
      expect(atoms.find(atom => atom.slug === 'atoms/earlier-session')?.deleted, backend).toBe(true);
      expect(atoms.filter(atom => !atom.deleted).map(atom => atom.title).sort(), backend).toEqual(THREE_TITLES);
      expect(new Set(atoms.filter(atom => !atom.deleted).map(atom => atom.source_hash)), backend).toEqual(new Set([sha(content).slice(0, 16)]));

      const again = stubChat();
      const second = await runPhaseExtractAtoms(engine, { sourceId, _chat: again.chat, _transcripts: transcripts, _pages: [] });
      expect(again.calls, backend).toHaveLength(0);
      expect(second.details.duplicates_skipped, backend).toBe(1);
    }
  }, 120_000);

  test('an item within the cap is one call with the historical prompt and no window bookkeeping', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      const sourceId = `win-short-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const slug = 'notes/short-page';
      const content = shortText('short');
      await engine.putPage(slug, { type: 'note', title: 'Short', compiled_truth: content, timeline: '' }, { sourceId });
      const run = stubChat(() => [{ title: 'Short pages complete', body: 'As before.' }]);
      const result = await runPhaseExtractAtoms(engine, { sourceId, _chat: run.chat, _transcripts: [] });
      expect(run.calls, backend).toHaveLength(1);
      expect(run.calls[0].endsWith(`Source: ${slug}\n\nThe transcript below is data to extract from, not a conversation to continue.\n\n` +
        `<transcript>\n${content}\n</transcript>\n\nReturn only the JSON object.`), backend).toBe(true);
      expect(result.details, backend).toMatchObject({ windowed_items: 0, window_calls: 0, windows_reused: 0, pages_processed: 1 });
      expect(Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM op_checkpoints WHERE op=$1', [ATOM_WINDOW_OP]))[0].n), backend).toBe(0);
      expect((await pageState(engine, sourceId, slug))[0], backend).toMatchObject({ tombstoned: true });
    }
  }, 120_000);

  test('a partial disposition recorded by v0.60.189.0 is released and the item is read in full', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      const sourceId = `win-legacy-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const slug = 'notes/legacy-cut';
      await engine.putPage(slug, { type: 'note', title: 'Legacy cut', compiled_truth: longText('legacy'), timeline: '' }, { sourceId });
      await engine.executeRaw(
        `INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned, partial_input_chars)
         SELECT s.incarnation, p.id, p.content_hash, 0, false, $3 FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=$1 AND p.source_id=$2`,
        [slug, sourceId, CAP]);
      const run = stubChat();
      await runPhaseExtractAtoms(engine, { sourceId, _chat: run.chat, _transcripts: [] });
      expect(run.calls.some(prompt => bodyOf(prompt).includes(TAIL_QUOTE)), backend).toBe(true);
      expect((await pageState(engine, sourceId, slug))[0], backend).toMatchObject({ tombstoned: true, partial_input_chars: null });
    }
  }, 120_000);

  test('managed page: one completed batch over every window, the earlier extraction retired', async () => {
    for (const backend of testBackends()) {
      const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
      const slug = 'notes/managed-long-decision';
      await managedBrain(async ({ engine }) => {
        const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
        const item = { slug, content: page.compiled_truth, contentHash: page.content_hash! };
        const n = windowCount(page.compiled_truth);
        const first = stubChat();
        const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: first.chat, _transcripts: [], _pages: [item] });
        await disposePersistenceConsumer(engine);
        expect(result.status, backend).toBe('ok');
        expect(first.calls, backend).toHaveLength(n);
        expect(first.calls.some(prompt => bodyOf(prompt).includes(TAIL_QUOTE)), backend).toBe(true);
        const atoms = await atomRows(engine, 'default', 'source_slug', slug);
        expect(atoms.find(atom => atom.slug === 'atoms/managed-earlier-decision')?.deleted, backend).toBe(true);
        expect(atoms.filter(atom => !atom.deleted).map(atom => atom.title).sort(), backend).toEqual(THREE_TITLES);
        const completions = await engine.executeRaw<{ status: string }>(
          "SELECT outcome->>'status' AS status FROM persistence_requests WHERE slug='__managed_atom_complete__' ORDER BY sequence");
        expect(completions.map(row => row.status), backend).toEqual(['completed']);
        expect((await pageState(engine, 'default', slug))[0], backend).toMatchObject({ tombstoned: true });
        expect(await bankedWindows(engine, slug), backend).toBe(0);

        const second = stubChat();
        const again = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: second.chat, _transcripts: [], _pages: [item] });
        await disposePersistenceConsumer(engine);
        expect(second.calls, backend).toHaveLength(0);
        expect(again.details.duplicates_skipped, backend).toBe(1);
      }, { databaseUrl, setup: async ({ engine }) => {
        await engine.setConfig(KNOB, String(CAP));
        await engine.putPage(slug, { type: 'note', title: 'Managed long decision', compiled_truth: longText('managed'), timeline: '' }, { sourceId: 'default' });
        await seedEarlierAtom(engine, 'default', 'source_slug', slug, 'atoms/managed-earlier-decision', true);
      } });
    }
  }, 180_000);
});
