/**
 * #6325: a failed managed atom batch is retried automatically, a bounded
 * number of times per content identity, inside the run budget. A strike lands
 * once per newly completed failure; after MAX_DETERMINISTIC_FAILURES the page
 * (or transcript) settles held_failed: out of discovery and the backlog, never
 * replayed as a failure, listed by doctor. A content change starts over.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, MAX_DETERMINISTIC_FAILURES, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { retryManagedAtomBatch } from '../src/core/persistence/atom-retry.ts';
import { atomHeldFailedEntry } from '../src/commands/doctor/checks/atom-holds.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await stopPersistenceConsumer(engine); await resetPgliteState(engine); });
afterAll(async () => { __setChatTransportForTests(null); await engine.disconnect(); resetGateway(); });

const VALID = JSON.stringify([{ title: 'Measured progress', atom_type: 'insight', body: 'Measure progress against clear exit criteria.' }]);

function fixture() {
  const replies: string[] = [];
  let calls = 0;
  const chat = async (): Promise<ChatResult> => {
    calls++;
    return { text: replies.shift() ?? 'not valid output', blocks: [], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { replies, chat, calls: () => calls };
}

async function managed<T>(work: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-atom-retry-'));
  try {
    return await withEnv({ GBRAIN_HOME: home }, () => work(home));
  } finally {
    __setChatTransportForTests(null);
    await stopPersistenceConsumer(engine);
    await setManaged(false);
    rmSync(home, { recursive: true, force: true });
  }
}

const setManaged = (on: boolean) => engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [on]);
const writePage = async (text: string) => {
  await setManaged(false);
  const page = await engine.putPage('notes/example', { type: 'note', title: 'Example',
    compiled_truth: `${text} `.repeat(40) }, { sourceId: 'default' });
  await setManaged(true);
  return page;
};

const checkpoints = () => engine.executeRaw<{ attempts: string | null; held: string | null; failure: string | null; request_id: string }>(
  `SELECT completed_keys->0->>'attempts' AS attempts, completed_keys->0->>'held' AS held, completed_keys->0->>'failure' AS failure,
     completed_keys->0->>'requestId' AS request_id
     FROM op_checkpoints WHERE op='managed-atoms' AND fingerprint NOT IN (
       SELECT DISTINCT intent->>'runKey' FROM persistence_requests WHERE intent->>'checkpointKey' IS NOT NULL)`);

const doctorHeld = async () => (await atomHeldFailedEntry.run({ engine } as unknown as DoctorContext) as Check[])[0]!;

const atomCount = async () => (await engine.executeRaw("SELECT id FROM pages WHERE type='atom' AND deleted_at IS NULL")).length;

test('a malformed reply, then a valid one: the next run retries on its own and extracts', async () => {
  await managed(async () => {
    const page = await writePage('A careful project record.');
    const f = fixture();
    const extract = () => runPhaseExtractAtoms(engine, { _transcripts: [],
      _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: f.chat });
    expect((await extract()).status).toBe('warn');
    expect(f.calls()).toBe(1);
    await disposePersistenceConsumer(engine);
    f.replies.push(VALID);
    const retried = await extract();
    expect(f.calls()).toBe(2);
    expect(retried.status).toBe('ok');
    expect(retried.details?.failures).toEqual([]);
    expect(await atomCount()).toBe(1);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
    await disposePersistenceConsumer(engine);
    await extract();
    expect(f.calls()).toBe(2);
  });
}, 60_000);

test('three malformed replies settle the page held_failed: out of the backlog, never replayed or re-struck', async () => {
  await managed(async () => {
    const page = await writePage('A careful project record.');
    const f = fixture();
    const extract = () => runPhaseExtractAtoms(engine, { _transcripts: [],
      _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: f.chat });
    for (let attempt = 1; attempt <= MAX_DETERMINISTIC_FAILURES; attempt++) {
      const run = await extract();
      expect(f.calls()).toBe(attempt);
      expect(run.details?.malformed_outputs).toBe(1);
      const [checkpoint] = await checkpoints();
      expect(Number(checkpoint.attempts)).toBe(attempt);
      expect(checkpoint.held === 'true').toBe(attempt === MAX_DETERMINISTIC_FAILURES);
      expect(await countExtractAtomsBacklog(engine, 'default')).toBe(attempt === MAX_DETERMINISTIC_FAILURES ? 0 : 1);
      await disposePersistenceConsumer(engine);
    }
    expect(await discoverExtractablePages(engine, 'default')).toEqual([]);
    const held = await extract();
    expect(f.calls()).toBe(MAX_DETERMINISTIC_FAILURES);
    expect(held.details?.failures).toEqual([]);
    expect(held.details?.held_failed).toBe(1);
    expect(await checkpoints()).toHaveLength(1);
    expect(Number((await checkpoints())[0].attempts)).toBe(MAX_DETERMINISTIC_FAILURES);
    expect(await engine.executeRaw('SELECT fail_count FROM extract_atoms_page_state WHERE page_id=$1', [page.id]))
      .toEqual([{ fail_count: MAX_DETERMINISTIC_FAILURES }]);
    expect(await atomCount()).toBe(0);
    const doctor = await doctorHeld();
    expect(categorizeCheck(doctor.name)).toBeTruthy();
    expect(doctor.status).toBe('warn');
    expect(doctor.message).toContain('held_failed');
    expect(doctor.details?.items).toEqual([expect.objectContaining({ source_id: 'default', kind: 'page', locator: page.slug,
      request_id: (await checkpoints())[0].request_id, attempts: MAX_DETERMINISTIC_FAILURES })]);
    expect(doctor.fix).toMatchObject({ consent: ['paid'], argv: ['gbrain', 'jobs', 'submit', 'extract-atoms-drain', '--params',
      JSON.stringify({ sourceId: 'default', retryRequestId: (await checkpoints())[0].request_id })] });

    // A content change is a new identity: discovery offers it and the count starts over.
    await disposePersistenceConsumer(engine);
    await writePage('A rewritten project record.');
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    const [changed] = await discoverExtractablePages(engine, 'default');
    f.replies.push(VALID);
    expect((await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [{ slug: changed.slug, content: changed.content, contentHash: changed.contentHash }], _chat: f.chat })).status).toBe('ok');
    expect(f.calls()).toBe(MAX_DETERMINISTIC_FAILURES + 1);
    expect(await atomCount()).toBe(1);
    expect((await doctorHeld()).status).toBe('ok');
  });
}, 90_000);

test('an explicit retry still runs a held page and clears it from doctor', async () => {
  await managed(async () => {
    const page = await writePage('A careful project record.');
    const f = fixture();
    const extract = () => runPhaseExtractAtoms(engine, { _transcripts: [],
      _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: f.chat });
    for (let attempt = 1; attempt <= MAX_DETERMINISTIC_FAILURES; attempt++) { await extract(); await disposePersistenceConsumer(engine); }
    const held = await doctorHeld();
    expect(held.status).toBe('warn');
    const requestId = (held.details?.items as Array<{ request_id: string }>)[0].request_id;
    f.replies.push(VALID);
    __setChatTransportForTests(f.chat);
    expect(await retryManagedAtomBatch(engine, 'default', requestId, 'job:61')).toMatchObject({ model_rerun: true });
    expect(f.calls()).toBe(MAX_DETERMINISTIC_FAILURES + 1);
    expect(await atomCount()).toBe(1);
    await disposePersistenceConsumer(engine);
    expect((await doctorHeld()).status).toBe('ok');
    await extract();
    expect(f.calls()).toBe(MAX_DETERMINISTIC_FAILURES + 1);
  });
}, 90_000);

test('a transcript origin is bounded the same way', async () => {
  await managed(async (home) => {
    const file = join(home, 'session.txt');
    const text = 'A careful session transcript about measured progress. '.repeat(40);
    writeFileSync(file, text);
    await setManaged(true);
    const f = fixture();
    const extract = () => runPhaseExtractAtoms(engine, { _pages: [], _transcripts: [{ filePath: file, content: text, contentHash: sha256(text) }], _chat: f.chat });
    for (let attempt = 1; attempt <= MAX_DETERMINISTIC_FAILURES; attempt++) {
      await extract();
      expect(f.calls()).toBe(attempt);
      await disposePersistenceConsumer(engine);
    }
    const held = await extract();
    expect(f.calls()).toBe(MAX_DETERMINISTIC_FAILURES);
    expect(held.details?.failures).toEqual([]);
    expect(held.details?.held_failed).toBe(1);
  });
}, 90_000);

test('a drain over a failed page retries it instead of stopping provider_failure on the replay', async () => {
  await managed(async () => {
    await writePage('A careful project record.');
    await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
    const f = fixture();
    __setChatTransportForTests(f.chat);
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-atom-retry' }, async () => {
      const first = await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120, maxBatches: 1 });
      expect(f.calls()).toBe(1);
      expect(first.failure_count).toBe(1);
      await disposePersistenceConsumer(engine);
      f.replies.push(VALID);
      const second = await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120, maxBatches: 3 });
      expect(f.calls()).toBe(2);
      expect(second.status).toBe('ok');
      expect(second.stopped).toBe('drained');
      expect(second.extracted).toBe(1);
      expect(second.remaining).toBe(0);
    });
  });
}, 60_000);
