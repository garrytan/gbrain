/**
 * #6503 (wave 16 G2.4, UC2): an extract_atoms item longer than
 * `cycle.extract_atoms.max_input_chars` is cut silently and then certified
 * complete. The model never reads the tail, the completion stamp lands on the
 * full content hash, and the unmanaged path retires every atom an earlier,
 * larger-cap extraction produced from that tail (the managed path publishes
 * the same retirement against the full origin).
 *
 * After the fix a cut item gets a *partial disposition*: `input_truncated`
 * counts it on the phase result (and the drain sums it), one stderr line
 * names the knob, the head is extracted once and its atoms published, no
 * completion stamp is written, nothing is retired, and the item is skipped
 * with zero model calls until the cap rises or the content changes. A 10k
 * item under the cap still completes as before.
 *
 * Every case drives the real `runPhaseExtractAtoms` with a stub model, on
 * PGLite and Postgres, unmanaged (page discovery + the transcript seam) and
 * managed (origin publication through the coordinator). The truncation
 * assertions come first in each case so the master failure is the missing
 * counter / the false completion, never the schema the fix adds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const CAP = 2_000;
const KNOB = 'cycle.extract_atoms.max_input_chars';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Prose with a surrogate pair straddling the cut so the UTF-8-safe boundary is exercised. */
function longText(label: string, chars = 3_000): string {
  const head = `${label}: the team decided to measure every launch against clear exit criteria. `.repeat(40).slice(0, CAP - 1);
  return (head + '😀' + ` ${label} tail: the model must never see this tail sentence about the hidden decision. `.repeat(40)).slice(0, chars);
}
const shortText = (label: string) => `${label}: a short page that fits under the cap and completes as before. `.repeat(20).slice(0, 1_200);

function stubChat(atoms: Array<{ title: string; body: string }> | (() => Array<{ title: string; body: string }>)) {
  const calls: string[] = [];
  const chat = async (opts: ChatOpts): Promise<ChatResult> => {
    const last = opts.messages[opts.messages.length - 1];
    calls.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
    const list = typeof atoms === 'function' ? atoms() : atoms;
    const text = JSON.stringify(list.map(atom => ({ ...atom, atom_type: 'insight' })));
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { calls, chat };
}

async function captureStderr<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { return { value: await run(), lines }; } finally { console.error = original; }
}

const atomRows = (engine: BrainEngine, sourceId: string, originKey: 'source_slug' | 'source_path', origin: string) =>
  engine.executeRaw<{ slug: string; source_hash: string; deleted: boolean }>(
    `SELECT slug, frontmatter->>'source_hash' AS source_hash, deleted_at IS NOT NULL AS deleted FROM pages
      WHERE source_id=$1 AND type='atom' AND frontmatter->>$2=$3 ORDER BY slug`, [sourceId, originKey, origin]);

const pageState = (engine: BrainEngine, sourceId: string, slug: string) =>
  engine.executeRaw<{ tombstoned: boolean; partial_input_chars: number | null }>(
    `SELECT scan.tombstoned, scan.partial_input_chars FROM extract_atoms_page_state scan
      JOIN pages p ON p.id=scan.page_id AND scan.content_hash=p.content_hash WHERE p.source_id=$1 AND p.slug=$2`, [sourceId, slug]);

const transcriptState = (engine: BrainEngine, sourceId: string, filePath: string) =>
  engine.executeRaw<{ tombstoned: boolean; partial_input_chars: number | null }>(
    'SELECT tombstoned, partial_input_chars FROM extract_atoms_transcript_state WHERE source_id=$1 AND file_path=$2', [sourceId, filePath]);

/** An atom an earlier, larger-cap extraction derived from the item's tail: another source_hash, same origin. */
async function seedTailAtom(engine: BrainEngine, sourceId: string, originKey: 'source_slug' | 'source_path', origin: string, slug: string, managed: boolean) {
  await engine.putPage(slug, { type: 'atom', title: 'Hidden decision from the tail', compiled_truth: 'The tail decision was recorded by an earlier extraction.',
    frontmatter: { atom_type: 'insight', [originKey]: origin, source_hash: 'earlier0000cap00', dream_generated: true, extracted_by: 'extract_atoms-v0.41.2.1',
      ...(managed ? { managed_extraction: true } : {}) } }, { sourceId });
  // GBRA-161: an atom from before the generation ledger is retired only on retained extractor evidence (a page version
  // the extractor wrote, unedited since), which a real earlier extraction leaves behind.
  await engine.createVersion(slug, { sourceId });
}

describe('extract_atoms partial disposition for items cut at max_input_chars (#6503)', () => {
  const engines: Array<{ backend: string; engine: BrainEngine; databaseUrl?: string }> = [];
  let closePostgres: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    for (const backend of testBackends()) {
      if (backend === 'pglite') {
        const engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        engines.push({ backend, engine });
      } else {
        const databaseUrl = requirePostgresTestDatabase();
        const isolated = await isolatedPersistencePostgres(databaseUrl);
        engines.push({ backend, engine: isolated.engine, databaseUrl });
        closePostgres = isolated.close;
      }
    }
  }, 120_000);
  afterAll(async () => {
    for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });

  test('the counter, the stderr line and the post-filter measurement: a cut page and transcript count, a short page and a paste-only overflow do not', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      const sourceId = `cut-count-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('notes/long-page', { type: 'note', title: 'Long', compiled_truth: longText('page'), timeline: '' }, { sourceId });
      await engine.putPage('notes/short-page', { type: 'note', title: 'Short', compiled_truth: shortText('short'), timeline: '' }, { sourceId });
      const cutTranscript = `[user]\n${longText('transcript')}\n`;
      const pasteTranscript = `[user]\nKeep this: <pasted_content id="1">\n${'x'.repeat(5_000)}\n</pasted_content>\n${shortText('after paste')}\n`;
      const { calls, chat } = stubChat([]);
      const { value: result, lines } = await captureStderr(() => runPhaseExtractAtoms(engine, {
        sourceId, _chat: chat,
        _transcripts: [
          { filePath: `/corpus/${sourceId}/cut.txt`, content: cutTranscript, contentHash: sha(cutTranscript) },
          { filePath: `/corpus/${sourceId}/paste.txt`, content: pasteTranscript, contentHash: sha(pasteTranscript) },
        ],
      }));
      expect(result.details.input_truncated, backend).toBe(2);
      expect(result.summary, backend).toContain('2 input-truncated');
      const truncatedLines = lines.filter(line => line.includes('input truncated'));
      expect(truncatedLines, backend).toHaveLength(2);
      for (const line of truncatedLines) expect(line, backend).toContain(KNOB);
      expect(truncatedLines.some(line => line.includes('notes/long-page')), backend).toBe(true);
      expect(truncatedLines.some(line => line.includes('/cut.txt')), backend).toBe(true);
      expect(calls, backend).toHaveLength(4);
      for (const sent of calls) {
        expect(sent, backend).not.toContain('tail sentence');
        expect(sent, backend).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      }
      expect(calls.some(sent => sent.includes('x'.repeat(100))), backend).toBe(false);
      expect((await pageState(engine, sourceId, 'notes/long-page'))[0], backend).toEqual({ tombstoned: false, partial_input_chars: CAP });
      expect((await pageState(engine, sourceId, 'notes/short-page'))[0], backend).toMatchObject({ tombstoned: true, partial_input_chars: null });
      expect((await transcriptState(engine, sourceId, `/corpus/${sourceId}/cut.txt`))[0], backend).toEqual({ tombstoned: false, partial_input_chars: CAP });
      expect((await transcriptState(engine, sourceId, `/corpus/${sourceId}/paste.txt`))[0], backend).toMatchObject({ tombstoned: true, partial_input_chars: null });
    }
  }, 120_000);

  test('unmanaged page: head atoms publish, the tail atom survives, no completion stamp, skipped until the cap rises', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      // GBRA-161: the released run replaces the head atom and the tail atom with one atom, a shrink the default floor holds.
      await engine.setConfig('generations.shrink_floor', '0.05');
      const sourceId = `cut-page-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const slug = 'notes/long-decision';
      await engine.putPage(slug, { type: 'note', title: 'Long decision', compiled_truth: longText('decision'), timeline: '' }, { sourceId });
      await seedTailAtom(engine, sourceId, 'source_slug', slug, 'atoms/tail-decision', false);
      const first = stubChat([{ title: 'Measure every launch', body: 'Measure every launch against clear exit criteria.' }]);
      const result = await runPhaseExtractAtoms(engine, { sourceId, _chat: first.chat, _transcripts: [] });
      expect(result.details.input_truncated, backend).toBe(1);
      expect(first.calls, backend).toHaveLength(1);
      let atoms = await atomRows(engine, sourceId, 'source_slug', slug);
      expect(atoms.find(atom => atom.slug === 'atoms/tail-decision'), backend).toMatchObject({ deleted: false, source_hash: 'earlier0000cap00' });
      const head = atoms.filter(atom => atom.slug !== 'atoms/tail-decision');
      expect(head, backend).toHaveLength(1);
      expect(head[0].source_hash, backend).toMatch(/^pending:/);
      expect((await pageState(engine, sourceId, slug))[0], backend).toEqual({ tombstoned: false, partial_input_chars: CAP });

      const second = stubChat([]);
      const again = await runPhaseExtractAtoms(engine, { sourceId, _chat: second.chat, _transcripts: [] });
      expect(second.calls, backend).toHaveLength(0);
      expect(again.details.pages_total ?? 0, backend).toBe(0);

      await engine.setConfig(KNOB, String(CAP * 2));
      const third = stubChat([{ title: 'Measure every launch', body: 'Measure every launch against clear exit criteria.' }]);
      const released = await runPhaseExtractAtoms(engine, { sourceId, _chat: third.chat, _transcripts: [] });
      expect(third.calls, backend).toHaveLength(1);
      expect(third.calls[0], backend).toContain('tail sentence');
      expect(released.details.input_truncated, backend).toBe(0);
      atoms = await atomRows(engine, sourceId, 'source_slug', slug);
      expect(atoms.find(atom => atom.slug === 'atoms/tail-decision')?.deleted, backend).toBe(true);
      const page = (await engine.getPage(slug, { sourceId }))!;
      expect(atoms.filter(atom => !atom.deleted).map(atom => atom.source_hash), backend).toEqual([page.content_hash!.slice(0, 16)]);
      expect((await pageState(engine, sourceId, slug))[0], backend).toMatchObject({ tombstoned: true, partial_input_chars: null });
    }
  }, 120_000);

  test('unmanaged transcript: the same disposition through the transcript seam', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      // GBRA-161: as above, one atom replaces two when the cap rises.
      await engine.setConfig('generations.shrink_floor', '0.05');
      const sourceId = `cut-transcript-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const filePath = `/corpus/${sourceId}/session.txt`;
      const content = `[user]\n${longText('session')}\n`;
      const transcripts = [{ filePath, content, contentHash: sha(content) }];
      await seedTailAtom(engine, sourceId, 'source_path', filePath, 'atoms/tail-session', false);
      const first = stubChat([{ title: 'Exit criteria first', body: 'Set exit criteria before measuring.' }]);
      const result = await runPhaseExtractAtoms(engine, { sourceId, _chat: first.chat, _transcripts: transcripts, _pages: [] });
      expect(result.details.input_truncated, backend).toBe(1);
      expect(first.calls, backend).toHaveLength(1);
      let atoms = await atomRows(engine, sourceId, 'source_path', filePath);
      expect(atoms.find(atom => atom.slug === 'atoms/tail-session'), backend).toMatchObject({ deleted: false });
      expect(atoms.filter(atom => atom.slug !== 'atoms/tail-session').map(atom => atom.source_hash), backend).toEqual([`pending:${sha(content).slice(0, 16)}`]);
      expect((await transcriptState(engine, sourceId, filePath))[0], backend).toEqual({ tombstoned: false, partial_input_chars: CAP });

      const second = stubChat([]);
      const again = await runPhaseExtractAtoms(engine, { sourceId, _chat: second.chat, _transcripts: transcripts, _pages: [] });
      expect(second.calls, backend).toHaveLength(0);
      expect(again.details.duplicates_skipped, backend).toBe(1);
      expect(again.details.input_truncated, backend).toBe(0);

      await engine.setConfig(KNOB, String(CAP * 2));
      const third = stubChat([{ title: 'Exit criteria first', body: 'Set exit criteria before measuring.' }]);
      await runPhaseExtractAtoms(engine, { sourceId, _chat: third.chat, _transcripts: transcripts, _pages: [] });
      expect(third.calls, backend).toHaveLength(1);
      expect(third.calls[0], backend).toContain('tail sentence');
      atoms = await atomRows(engine, sourceId, 'source_path', filePath);
      expect(atoms.find(atom => atom.slug === 'atoms/tail-session')?.deleted, backend).toBe(true);
      expect(atoms.filter(atom => !atom.deleted).map(atom => atom.source_hash), backend).toEqual([sha(content).slice(0, 16)]);
      expect((await transcriptState(engine, sourceId, filePath))[0], backend).toMatchObject({ partial_input_chars: null });
    }
  }, 120_000);

  test('managed page: the origin publishes head atoms with no retirement and a partial checkpoint; a raised cap is a new run', async () => {
    for (const backend of testBackends()) {
      const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
      const slug = 'notes/managed-long-decision';
      await managedBrain(async ({ engine }) => {
        const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
        const item = { slug, content: page.compiled_truth, contentHash: page.content_hash! };
        const first = stubChat([{ title: 'Measure every launch', body: 'Measure every launch against clear exit criteria.' }]);
        const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: first.chat, _transcripts: [], _pages: [item] });
        await disposePersistenceConsumer(engine);
        expect(result.details.input_truncated, backend).toBe(1);
        expect(result.status, backend).toBe('ok');
        expect(first.calls, backend).toHaveLength(1);
        const atoms = await atomRows(engine, 'default', 'source_slug', slug);
        expect(atoms.find(atom => atom.slug === 'atoms/managed-tail-decision'), backend).toMatchObject({ deleted: false });
        expect(atoms.filter(atom => atom.slug !== 'atoms/managed-tail-decision' && !atom.deleted), backend).toHaveLength(1);
        const checkpoints = await engine.executeRaw<{ partial: string | null; failure: string | null }>(
          `SELECT completed_keys->0->>'partial' AS partial, completed_keys->0->>'failure' AS failure FROM op_checkpoints
            WHERE op='managed-atoms' AND completed_keys->0->>'locator'=$1`, [slug]);
        expect(checkpoints, backend).toEqual([{ partial: String(CAP), failure: null }]);
        expect(await pageState(engine, 'default', slug), backend).toEqual([]);
        const completions = await engine.executeRaw<{ outcome: { status: string; retired: number } }>(
          "SELECT outcome FROM persistence_requests WHERE slug='__managed_atom_complete__' ORDER BY sequence");
        expect(completions.map(row => row.outcome.status), backend).toEqual(['partial']);
        expect(completions[0].outcome.retired, backend).toBe(0);

        const second = stubChat([]);
        const again = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: second.chat, _transcripts: [], _pages: [item] });
        await disposePersistenceConsumer(engine);
        expect(second.calls, backend).toHaveLength(0);
        expect(again.details.duplicates_skipped, backend).toBe(1);
        expect(again.details.input_truncated, backend).toBe(0);

        await engine.setConfig(KNOB, String(CAP * 2));
        const third = stubChat([{ title: 'Measure every launch', body: 'Measure every launch against clear exit criteria.' }]);
        const released = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: third.chat, _transcripts: [], _pages: [item] });
        await disposePersistenceConsumer(engine);
        expect(third.calls, backend).toHaveLength(1);
        expect(third.calls[0], backend).toContain('tail sentence');
        expect(released.details.input_truncated, backend).toBe(0);
        const after = await atomRows(engine, 'default', 'source_slug', slug);
        expect(after.find(atom => atom.slug === 'atoms/managed-tail-decision')?.deleted, backend).toBe(true);
        expect((await engine.executeRaw<{ status: string }>(
          "SELECT outcome->>'status' AS status FROM persistence_requests WHERE slug='__managed_atom_complete__' ORDER BY sequence")).map(row => row.status), backend)
          .toEqual(['partial', 'completed']);
        expect((await pageState(engine, 'default', slug))[0], backend).toMatchObject({ tombstoned: true });
      }, { databaseUrl, setup: async ({ engine }) => {
        await engine.setConfig(KNOB, String(CAP));
        await engine.putPage(slug, { type: 'note', title: 'Managed long decision', compiled_truth: longText('managed'), timeline: '' }, { sourceId: 'default' });
        await seedTailAtom(engine, 'default', 'source_slug', slug, 'atoms/managed-tail-decision', true);
      } });
    }
  }, 180_000);
});
