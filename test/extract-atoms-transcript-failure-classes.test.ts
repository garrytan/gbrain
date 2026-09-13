/**
 * v146 — extract_atoms failure classes for TRANSCRIPT items.
 *
 * The transcript half of gbrain#4148. Pre-fix `recordPageFailureCount` opened
 * with `if (item.kind !== 'page' ...) return null`, and both tombstone stamps
 * were gated `item.kind === 'page'`, so transcripts had:
 *   - no durable failure count,
 *   - no bounded tombstone for deterministically-malformed output,
 *   - no zero-yield marker at all.
 * Transcript eligibility is gated ONLY by `atomsExistingForHashes` ("does an
 * atom row exist for this content hash"), and a failed or empty extraction
 * leaves no atom row — so such a transcript re-entered the work pool and
 * re-spent LLM budget on EVERY cycle, forever. TODOS.md P2(b).
 *
 * These mirror test/extract-atoms-failure-classes.test.ts, which is the house
 * convention for this machinery, with the page assertions restated against the
 * `extract_atoms_transcript_state` table instead of page frontmatter.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  runPhaseExtractAtoms,
  MAX_DETERMINISTIC_FAILURES,
} from '../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function okChatResult(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  } as ChatResult;
}

const HASH_A = 'a'.repeat(16);
const HASH_B = 'b'.repeat(16);
const FILE = '/corpus/session-one.txt';
const ATOM_JSON = JSON.stringify([
  { title: 'A durable insight', atom_type: 'insight', body: 'The insight body prose.' },
]);

/** The transcript work-item seam, mirroring `_pages` in the sibling file. */
function transcript(filePath: string, contentHash: string) {
  return { filePath, content: 'transcript prose body', contentHash };
}

async function stateRow(
  filePath: string,
  contentHash: string,
): Promise<{ fail_count: number; tombstoned: boolean } | undefined> {
  const rows = await engine.executeRaw<{ fail_count: number | string; tombstoned: boolean | string }>(
    `SELECT fail_count, tombstoned FROM extract_atoms_transcript_state
      WHERE source_id = 'default' AND file_path = $1 AND content_hash = $2`,
    [filePath, contentHash],
  );
  const r = rows[0];
  if (!r) return undefined;
  return { fail_count: Number(r.fail_count), tombstoned: r.tombstoned === true || r.tombstoned === 't' };
}

describe('transcript failure counting (v146)', () => {
  test('malformed output is a COUNTED failure for a transcript, not a silent retry-forever', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (_o: ChatOpts) => okChatResult('no json in sight'),
    });
    expect(result.details.malformed_outputs).toBe(1);
    const failures = result.details.failures as Array<{ error: string }>;
    expect(failures[0].error).toContain('malformed model output');
    // Pre-fix the count was null for transcripts, so the message carried no
    // streak suffix at all — that absence WAS the bug's fingerprint.
    expect(failures[0].error).toContain('consecutive failure 1 on this content');
    const row = await stateRow(FILE, HASH_A);
    expect(row).toBeDefined();
    expect(row!.fail_count).toBe(1);
    expect(row!.tombstoned).toBe(false);
  });

  test(`tombstones only after ${MAX_DETERMINISTIC_FAILURES} consecutive same-content malformed failures`, async () => {
    const opts = {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (_o: ChatOpts) => okChatResult('still not json'),
    };
    for (let i = 1; i < MAX_DETERMINISTIC_FAILURES; i++) {
      const r = await runPhaseExtractAtoms(engine, opts);
      expect(r.details.tombstoned_transcripts).toEqual([]);
      const row = await stateRow(FILE, HASH_A);
      expect(row!.fail_count).toBe(i);
      expect(row!.tombstoned).toBe(false);
    }
    const final = await runPhaseExtractAtoms(engine, opts);
    expect(final.details.tombstoned_transcripts).toEqual([FILE]);
    const row = await stateRow(FILE, HASH_A);
    expect(row!.fail_count).toBe(MAX_DETERMINISTIC_FAILURES);
    expect(row!.tombstoned).toBe(true);
  });

  test('a content edit resets the streak (state is hash-keyed)', async () => {
    const mk = (hash: string) => ({
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, hash)],
      _chat: async (_o: ChatOpts) => okChatResult('nope'),
    });
    await runPhaseExtractAtoms(engine, mk(HASH_A));
    await runPhaseExtractAtoms(engine, mk(HASH_A));
    expect((await stateRow(FILE, HASH_A))!.fail_count).toBe(2);
    await runPhaseExtractAtoms(engine, mk(HASH_B)); // edited transcript
    expect((await stateRow(FILE, HASH_B))!.fail_count).toBe(1);
    // The old row survives untouched — the streak did not carry over.
    expect((await stateRow(FILE, HASH_A))!.fail_count).toBe(2);
  });

  test('transient provider errors are retryable: no count, no tombstone', async () => {
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (_o: ChatOpts) => { throw new Error('fetch failed: 503 upstream timeout'); },
    });
    expect(await stateRow(FILE, HASH_A)).toBeUndefined();
  });
});

describe('transcript zero-yield tombstone (v146)', () => {
  test('an honest empty extraction tombstones IMMEDIATELY, as it does for pages', async () => {
    // The behaviour with the largest practical effect: pre-fix a transcript
    // that legitimately yields nothing left no atom row, so it was re-attempted
    // on every cycle forever. One clean call is a settled answer about this
    // content and needs no streak.
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (_o: ChatOpts) => okChatResult('[]'),
    });
    expect(result.details.transcripts_processed).toBe(1);
    expect(result.details.atoms_extracted).toBe(0);
    const row = await stateRow(FILE, HASH_A);
    expect(row).toBeDefined();
    expect(row!.tombstoned).toBe(true);
    expect(row!.fail_count).toBe(0); // a zero-yield is NOT a failure
  });

  test('the zero-yield tombstone is honored on the next run (the read side)', async () => {
    // Without the discovery-filter half, the row above would be written and
    // then ignored — a counter nothing reads is inert.
    const empty = async (_o: ChatOpts) => okChatResult('[]');
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default', _pages: [], _transcripts: [transcript(FILE, HASH_A)], _chat: empty,
    });
    let calls = 0;
    const second = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (o: ChatOpts) => { calls++; return empty(o); },
    });
    expect(calls).toBe(0); // never reached the LLM again
    expect(second.details.transcripts_processed).toBe(0);
    expect(second.details.duplicates_skipped).toBe(1);
  });

  test('editing a tombstoned transcript re-eligibilizes it', async () => {
    // This is what makes the permanence safe: the tombstone is bound to the
    // content that earned it, never to the path.
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (_o: ChatOpts) => okChatResult('[]'),
    });
    let calls = 0;
    const after = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_B)], // same path, edited content
      _chat: async (_o: ChatOpts) => { calls++; return okChatResult(ATOM_JSON); },
    });
    expect(calls).toBe(1);
    expect(after.details.atoms_extracted).toBe(1);
  });

  test('a malformed-output tombstone is honored on the next run too', async () => {
    const opts = {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (_o: ChatOpts) => okChatResult('not json'),
    };
    for (let i = 0; i < MAX_DETERMINISTIC_FAILURES; i++) {
      await runPhaseExtractAtoms(engine, opts);
    }
    let calls = 0;
    const after = await runPhaseExtractAtoms(engine, {
      ...opts,
      _chat: async (_o: ChatOpts) => { calls++; return okChatResult('not json'); },
    });
    expect(calls).toBe(0); // budget no longer burned on this content
    expect(after.details.duplicates_skipped).toBe(1);
  });

  test('an in-progress streak does NOT suppress the transcript (only a tombstone does)', async () => {
    // fail_count 1 or 2 must stay live and keep being retried, mirroring a page
    // whose atoms_fail_count is below the bound.
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (_o: ChatOpts) => okChatResult('not json'),
    });
    let calls = 0;
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (_o: ChatOpts) => { calls++; return okChatResult('not json'); },
    });
    expect(calls).toBe(1);
  });
});

describe('transcript state is source-scoped (v146)', () => {
  test("one source's tombstone does not suppress the same file under another source", async () => {
    // The reason source_id is in the key. The phase is source-scoped
    // throughout — discovery SQL, the NOT EXISTS idempotency subquery, and
    // every putPage take sourceId — and this file's header records the
    // federated-brain bug caused by forgetting it once already.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dept-x', 'dept-x') ON CONFLICT (id) DO NOTHING`,
    );
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (_o: ChatOpts) => okChatResult('[]'),
    });
    expect((await stateRow(FILE, HASH_A))!.tombstoned).toBe(true);

    let calls = 0;
    const other = await runPhaseExtractAtoms(engine, {
      sourceId: 'dept-x',
      _pages: [],
      _transcripts: [transcript(FILE, HASH_A)],
      _chat: async (_o: ChatOpts) => { calls++; return okChatResult(ATOM_JSON); },
    });
    expect(calls).toBe(1); // dept-x still extracts it
    expect(other.details.atoms_extracted).toBe(1);
  });
});
