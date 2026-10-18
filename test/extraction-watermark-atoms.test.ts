/**
 * Large pages A7 (eng F24) with the #6503 partial disposition: extract_atoms
 * reads the text appended to a page over `cycle.extract_atoms.max_input_chars`
 * instead of its head again, and a tail read is still partial input.
 *
 * 1. Protects: an append past the cap reaches the model; the tail run writes
 *    no completion stamp and retires no atom from earlier reads; a cut read
 *    leaves a receipt that doctor's extraction_input_truncated warns about.
 * 2. Regression that fails it: re-reading the head on every content change
 *    (pre-A7), or treating a tail read as a complete read (which would stamp
 *    the page and retire the head's atoms).
 * 3. The #6503 suite covers the head cut only; nothing covers an append.
 * 4. No new seam: `_chat` and the page discovery are the phase's own inputs.
 *
 * PGLite, plus Postgres when DATABASE_URL is set. Stub model ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { extractionInputTruncatedEntry } from '../src/commands/doctor/checks/extraction-input.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const CAP = 2_000;
const KNOB = 'cycle.extract_atoms.max_input_chars';

const prose = (tag: string, chars: number) =>
  `${tag}: the team agreed to measure every launch against clear exit criteria before shipping. `.repeat(Math.ceil(chars / 80)).slice(0, chars);

function stubChat(title: string) {
  const calls: string[] = [];
  const chat = async (opts: ChatOpts): Promise<ChatResult> => {
    const last = opts.messages[opts.messages.length - 1];
    calls.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
    const text = JSON.stringify([{ title, body: `${title}, decided in the meeting.`, atom_type: 'insight' }]);
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

const liveAtoms = (engine: BrainEngine, sourceId: string, slug: string) =>
  engine.executeRaw<{ title: string; source_hash: string }>(
    `SELECT title, frontmatter->>'source_hash' AS source_hash FROM pages
      WHERE source_id=$1 AND type='atom' AND frontmatter->>'source_slug'=$2 AND deleted_at IS NULL ORDER BY title`, [sourceId, slug]);

const currentState = (engine: BrainEngine, sourceId: string, slug: string) =>
  engine.executeRaw<{ tombstoned: boolean; partial_input_chars: number | null }>(
    `SELECT scan.tombstoned, scan.partial_input_chars FROM extract_atoms_page_state scan
      JOIN pages p ON p.id=scan.page_id AND scan.content_hash=p.content_hash WHERE p.source_id=$1 AND p.slug=$2`, [sourceId, slug]);

async function receipt(engine: BrainEngine, sourceId: string, slug: string): Promise<Record<string, unknown> | null> {
  const [row] = await engine.executeRaw<{ input_truncated: Record<string, unknown> | string | null }>(
    `SELECT s.input_truncated FROM page_extraction_state s JOIN pages p ON p.id=s.page_id
      WHERE p.source_id=$1 AND p.slug=$2 AND s.pipeline='extract_atoms'`, [sourceId, slug]);
  const value = row?.input_truncated ?? null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

describe('extract_atoms reads the appended tail and keeps the partial disposition (A7, #6503)', () => {
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

  test('an append past the cap is read from the appended text, never stamped complete, and retires nothing', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      const sourceId = `a7-atoms-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const slug = 'notes/a7-growing-log';
      const head = prose('HEADPART', 3_000);
      await engine.putPage(slug, { type: 'note', title: 'Growing log', compiled_truth: head, timeline: '' }, { sourceId });

      const first = stubChat('Head decision');
      await runPhaseExtractAtoms(engine, { sourceId, _chat: first.chat, _transcripts: [] });
      expect(first.calls, backend).toHaveLength(1);
      expect(first.calls[0], backend).toContain('HEADPART');
      expect(await receipt(engine, sourceId, slug), backend).toMatchObject({ kind: 'head', reason: 'no_watermark', processed_chars: CAP });

      const appended = head + prose('TAILPART', 1_000);
      await engine.putPage(slug, { type: 'note', title: 'Growing log', compiled_truth: appended, timeline: '' }, { sourceId });
      const second = stubChat('Tail decision');
      const { value: tailRun, lines } = await captureStderr(() => runPhaseExtractAtoms(engine, { sourceId, _chat: second.chat, _transcripts: [] }));
      expect(second.calls, backend).toHaveLength(1);
      expect(second.calls[0], backend).toContain('TAILPART');
      expect(second.calls[0], backend).not.toContain('HEADPART');
      // A complete tail read is not a cut: no counter, no stderr line.
      expect(tailRun.details.input_truncated, backend).toBe(0);
      expect(lines.filter(line => line.includes('[extract_atoms]') && line.includes(slug)), backend).toEqual([]);
      // #6503: partial input, so no completion stamp and the head's atom is not retired.
      expect(await currentState(engine, sourceId, slug), backend).toEqual([{ tombstoned: false, partial_input_chars: CAP }]);
      const atoms = await liveAtoms(engine, sourceId, slug);
      expect(atoms.map(atom => atom.title), backend).toEqual(['Head decision', 'Tail decision']);
      for (const atom of atoms) expect(atom.source_hash, backend).toMatch(/^pending:/);
      expect(await receipt(engine, sourceId, slug), backend).toMatchObject({ kind: 'head' });

      const longer = appended + prose('OLDAPPEND', 2_000) + prose('NEWAPPEND', 2_000);
      await engine.putPage(slug, { type: 'note', title: 'Growing log', compiled_truth: longer, timeline: '' }, { sourceId });
      const third = stubChat('Newest decision');
      const { value: windowRun, lines: windowLines } = await captureStderr(() => runPhaseExtractAtoms(engine, { sourceId, _chat: third.chat, _transcripts: [] }));
      expect(third.calls[0], backend).toContain('NEWAPPEND');
      expect(third.calls[0], backend).not.toContain('TAILPART');
      expect(windowRun.details.input_truncated, backend).toBe(1);
      expect(windowLines.some(line => line.includes(slug) && line.includes('appended since the last extraction')), backend).toBe(true);
      expect(await receipt(engine, sourceId, slug), backend).toMatchObject({ kind: 'tail_window', total_chars: longer.length - appended.length });
      expect((await liveAtoms(engine, sourceId, slug)).map(atom => atom.title), backend).toEqual(['Head decision', 'Newest decision', 'Tail decision']);

      const checks = await extractionInputTruncatedEntry.run({ engine } as unknown as DoctorContext) as Check[];
      const check = checks.find(c => c.name === 'extraction_input_truncated')!;
      expect(check.status, backend).toBe('warn');
      expect(check.message, backend).toContain(`${sourceId}:${slug}`);
      expect(check.fix, backend).toMatchObject({ argv: ['gbrain', 'config', 'set', KNOB, '<n>'], ask_user: true });
    }
  }, 120_000);

  test('an edit inside the read prefix falls back to the head with a prefix_changed receipt', async () => {
    for (const { backend, engine } of engines) {
      await engine.setConfig(KNOB, String(CAP));
      const sourceId = `a7-atoms-edit-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const slug = 'notes/a7-edited-log';
      const body = prose('ORIGINAL', 3_000);
      await engine.putPage(slug, { type: 'note', title: 'Edited log', compiled_truth: body, timeline: '' }, { sourceId });
      await runPhaseExtractAtoms(engine, { sourceId, _chat: stubChat('First decision').chat, _transcripts: [] });
      const edited = 'REWRITTEN opening line.\n' + body + prose('APPENDED', 500);
      await engine.putPage(slug, { type: 'note', title: 'Edited log', compiled_truth: edited, timeline: '' }, { sourceId });
      const second = stubChat('Second decision');
      await runPhaseExtractAtoms(engine, { sourceId, _chat: second.chat, _transcripts: [] });
      expect(second.calls[0], backend).toContain('REWRITTEN opening line.');
      expect(second.calls[0], backend).not.toContain('APPENDED');
      expect(await receipt(engine, sourceId, slug), backend).toMatchObject({ kind: 'head', reason: 'prefix_changed' });
      expect(await currentState(engine, sourceId, slug), backend).toEqual([{ tombstoned: false, partial_input_chars: CAP }]);
    }
  }, 120_000);
});
