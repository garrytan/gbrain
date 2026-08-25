/**
 * gbrain#4148 — extract_atoms failure classes, bounded tombstone, and the
 * partial-persist completion receipt.
 *
 * Pre-fix defects these pin (each red on master at the assertion):
 *  1. Malformed model output and legit zero-yield both parsed to `[]`, so
 *     malformed output was TOMBSTONED AS SUCCESS — the page never retried
 *     and its atoms were silently lost.
 *  2. No durable failure count existed — a deterministically-failing page
 *     re-entered discovery forever (the --drain backlog floor never cleared).
 *  3. Atom writes were per-atom while discovery treated ANY atom row with a
 *     matching source_hash as item-complete — a partial persist (atom 1
 *     written, atom 2 failed) skipped the item on every later run.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  runPhaseExtractAtoms,
  discoverExtractablePages,
  parseAtomsOutcome,
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
const ATOM_JSON = JSON.stringify([
  { title: 'A durable insight', atom_type: 'insight', body: 'The insight body prose.' },
]);

async function seedPage(slug: string): Promise<void> {
  await engine.putPage(slug, {
    title: slug,
    type: 'note',
    compiled_truth: 'seed body prose',
  } as never, { sourceId: 'default' });
}

async function frontmatterOf(slug: string): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> | string | null }>(
    `SELECT frontmatter FROM pages WHERE source_id = 'default' AND slug = $1`,
    [slug],
  );
  const fm = rows[0]?.frontmatter;
  if (fm == null) return {};
  return typeof fm === 'string' ? JSON.parse(fm) : fm;
}

describe('parseAtomsOutcome — typed parse (gbrain#4148)', () => {
  test('malformed shapes are ok:false, never an empty success', () => {
    expect(parseAtomsOutcome('sorry, I cannot help with that')).toEqual({ ok: false, reason: 'no JSON array in response' });
    expect(parseAtomsOutcome('[ {"title": "broken"')).toEqual({ ok: false, reason: 'unterminated JSON array' });
    expect(parseAtomsOutcome('[ %%% ] trailing')).toMatchObject({ ok: false });
  });

  test('legit zero-yield and valid extractions stay ok:true', () => {
    expect(parseAtomsOutcome('[]')).toEqual({ ok: true, atoms: [] });
    const out = parseAtomsOutcome(ATOM_JSON);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.atoms).toHaveLength(1);
  });
});

describe('runPhaseExtractAtoms — failure classes (gbrain#4148)', () => {
  test('prompt truncation never splits a UTF-16 surrogate pair', async () => {
    await seedPage('note/surrogate-boundary');
    const content = `${'a'.repeat(49_999)}💡trailing prose`;
    let capturedPrompt = '';

    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'note/surrogate-boundary', content, contentHash: HASH_A }],
      _chat: async (opts: ChatOpts) => {
        capturedPrompt = String(opts.messages[0]?.content);
        return okChatResult('[]');
      },
    });

    expect(content.slice(0, 50_000).isWellFormed()).toBe(false); // positive control
    expect(capturedPrompt.isWellFormed()).toBe(true);
    // Truncation must actually occur (not a no-op that trivially passes well-formedness):
    // the straddling pair moves the safe cut back to 49,999 'a's, dropping both the emoji
    // and the trailing prose from the sent prompt entirely.
    expect(capturedPrompt).not.toContain('trailing prose');
    expect(capturedPrompt).toContain('a'.repeat(49_999));
    expect(capturedPrompt.length).toBe(`Source: note/surrogate-boundary\n\n---\n\n${'a'.repeat(49_999)}`.length);
  });

  test('malformed output is a counted failure, NOT a zero-yield tombstone', async () => {
    await seedPage('note/m1');
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'note/m1', content: 'prose', contentHash: HASH_A }],
      _chat: async (_o: ChatOpts) => okChatResult('no json in sight'),
    });
    expect(result.details.malformed_outputs).toBe(1);
    expect((result.details.failures as Array<{ error: string }>)[0].error).toContain('malformed model output');
    expect(result.details.pages_processed).toBe(0);
    const fm = await frontmatterOf('note/m1');
    expect(fm.atoms_scan_hash).toBeUndefined(); // the pre-fix bug: this was stamped
    expect(Number(fm.atoms_fail_count)).toBe(1);
    expect(fm.atoms_fail_hash).toBe(HASH_A);
  });

  test(`tombstones only after ${MAX_DETERMINISTIC_FAILURES} consecutive same-content malformed failures`, async () => {
    await seedPage('note/m2');
    const opts = {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'note/m2', content: 'prose', contentHash: HASH_A }],
      _chat: async (_o: ChatOpts) => okChatResult('still not json'),
    };
    for (let i = 1; i < MAX_DETERMINISTIC_FAILURES; i++) {
      const r = await runPhaseExtractAtoms(engine, opts);
      expect(r.details.tombstoned_for_failures).toEqual([]);
      const fm = await frontmatterOf('note/m2');
      expect(Number(fm.atoms_fail_count)).toBe(i);
      expect(fm.atoms_scan_hash).toBeUndefined();
    }
    const final = await runPhaseExtractAtoms(engine, opts);
    expect(final.details.tombstoned_for_failures).toEqual(['note/m2']);
    const fm = await frontmatterOf('note/m2');
    expect(Number(fm.atoms_fail_count)).toBe(MAX_DETERMINISTIC_FAILURES);
    expect(fm.atoms_scan_hash).toBe(HASH_A); // backlog floor clears
  });

  test('a content edit resets the failure streak (count is hash-keyed)', async () => {
    await seedPage('note/m3');
    const mk = (hash: string) => ({
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'note/m3', content: 'prose', contentHash: hash }],
      _chat: async (_o: ChatOpts) => okChatResult('nope'),
    });
    await runPhaseExtractAtoms(engine, mk(HASH_A));
    await runPhaseExtractAtoms(engine, mk(HASH_A));
    expect(Number((await frontmatterOf('note/m3')).atoms_fail_count)).toBe(2);
    await runPhaseExtractAtoms(engine, mk('b'.repeat(16))); // edited content
    const fm = await frontmatterOf('note/m3');
    expect(Number(fm.atoms_fail_count)).toBe(1);
    expect(fm.atoms_fail_hash).toBe('b'.repeat(16));
  });

  test('transient provider errors are retryable: no count, no tombstone', async () => {
    await seedPage('note/t1');
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'note/t1', content: 'prose', contentHash: HASH_A }],
      _chat: async (_o: ChatOpts) => { throw new Error('fetch failed: 503 upstream timeout'); },
    });
    const failures = result.details.failures as Array<{ error: string }>;
    expect(failures[0].error).toContain('[transient — retried next run]');
    const fm = await frontmatterOf('note/t1');
    expect(fm.atoms_fail_count).toBeUndefined();
    expect(fm.atoms_scan_hash).toBeUndefined();
  });
});

// #3044 adoption — a whole-run LLM outage (revoked key, exhausted spend
// limit, sustained 429s) halts the phase instead of failing every item one
// by one, and must NOT pre-charge the per-page tombstone counters: the
// content did nothing wrong, so a restored provider must retry every page
// with a clean failure streak.
describe('runPhaseExtractAtoms — global-error halt (#3044)', () => {
  const mkPages = (slugs: string[]) =>
    slugs.map((slug, i) => ({ slug, content: 'prose', contentHash: String(i).repeat(16) }));

  test('auth error halts on the FIRST hit without charging the per-page failure counter', async () => {
    await seedPage('note/g1');
    await seedPage('note/g2');
    let calls = 0;
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: mkPages(['note/g1', 'note/g2']),
      _chat: async (_o: ChatOpts) => {
        calls++;
        throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
      },
    });
    expect(calls).toBe(1); // page 2 never called the LLM
    expect(result.details.aborted_global_error).toBe('auth');
    expect(result.status).toBe('warn');
    const failures = result.details.failures as Array<{ error: string }>;
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toContain('whole-run condition');
    // The global outage did not pre-charge the tombstone counter.
    for (const slug of ['note/g1', 'note/g2']) {
      const fm = await frontmatterOf(slug);
      expect(fm.atoms_fail_count).toBeUndefined();
      expect(fm.atoms_scan_hash).toBeUndefined();
    }
  });

  test('bare 429s halt only after 3 CONSECUTIVE hits; no page is counted or tombstoned', async () => {
    for (const slug of ['note/r1', 'note/r2', 'note/r3', 'note/r4']) await seedPage(slug);
    let calls = 0;
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: mkPages(['note/r1', 'note/r2', 'note/r3', 'note/r4']),
      _chat: async (_o: ChatOpts) => {
        calls++;
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    });
    expect(calls).toBe(3); // page 4 never called the LLM
    expect(result.details.aborted_global_error).toBe('rate_limit');
    const failures = result.details.failures as Array<{ error: string }>;
    expect(failures).toHaveLength(3); // 2 transient warnings + 1 abort entry
    expect(failures[2].error).toContain('3 consecutive rate_limit errors');
    for (const slug of ['note/r1', 'note/r2', 'note/r3', 'note/r4']) {
      expect((await frontmatterOf(slug)).atoms_fail_count).toBeUndefined();
    }
  });

  test('a successful call between 429s resets the streak (no halt)', async () => {
    for (const slug of ['note/s1', 'note/s2', 'note/s3', 'note/s4']) await seedPage(slug);
    let calls = 0;
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: mkPages(['note/s1', 'note/s2', 'note/s3', 'note/s4']),
      _chat: async (_o: ChatOpts) => {
        calls++;
        // 429, 429, success, 429 — never 3 in a row.
        if (calls === 3) return okChatResult('[]');
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    });
    expect(calls).toBe(4);
    expect(result.details.aborted_global_error).toBeUndefined();
    expect((result.details.failures as unknown[])).toHaveLength(3);
  });
});

// Doctor's extract_health check reads extract_rollup_7d's halt_count /
// round_completed_count to compute a per-kind halt rate and WARNs above
// 10%. TRANSIENT_EXTRACT_ERROR_RE's own doc comment says transient
// provider/infra errors are "retryable, never counted" — these tests pin
// that the rollup honors it, instead of using failures.length (which
// includes transient entries for CLI/receipt reporting and would
// misreport a heavy-but-healthy run as failing).
describe('runPhaseExtractAtoms — extract_health rollup excludes transient failures', () => {
  const mkPages = (slugs: string[]) =>
    slugs.map((slug, i) => ({ slug, content: 'prose', contentHash: String(i).repeat(16) }));

  async function rollupRow(kind: string): Promise<{ halt_count: number; round_completed_count: number } | undefined> {
    const rows = await engine.executeRaw<{ halt_count: number; round_completed_count: number }>(
      `SELECT halt_count, round_completed_count FROM extract_rollup_7d WHERE kind = $1 AND source_id = 'default'`,
      [kind],
    );
    return rows[0];
  }

  test('a run with only transient item-level errors counts as completed, not halted', async () => {
    await seedPage('note/rt1');
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'note/rt1', content: 'prose', contentHash: HASH_A }],
      _chat: async (_o: ChatOpts) => { throw new Error('fetch failed: 503 upstream timeout'); },
    });
    const row = await rollupRow('atoms');
    expect(row).toBeDefined();
    expect(row!.halt_count).toBe(0);
    expect(row!.round_completed_count).toBe(1);
  });

  test('a genuine non-transient failure (malformed output) still counts as a halt', async () => {
    await seedPage('note/rh1');
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'note/rh1', content: 'prose', contentHash: HASH_A }],
      _chat: async (_o: ChatOpts) => okChatResult('no json in sight'),
    });
    const row = await rollupRow('atoms');
    expect(row).toBeDefined();
    expect(row!.halt_count).toBe(1);
    expect(row!.round_completed_count).toBe(0);
  });

  test('a genuine non-transient THROWN error (not malformed output, not a global-abort class) still counts as a halt', async () => {
    await seedPage('note/rh2');
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'note/rh2', content: 'prose', contentHash: HASH_A }],
      _chat: async (_o: ChatOpts) => { throw new Error('unexpected internal error: null pointer'); },
    });
    const row = await rollupRow('atoms');
    expect(row).toBeDefined();
    expect(row!.halt_count).toBe(1);
    expect(row!.round_completed_count).toBe(0);
  });

  test('an auth-abort (genuinely broken credentials) still counts as a halt', async () => {
    await seedPage('note/rg1');
    await seedPage('note/rg2');
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: mkPages(['note/rg1', 'note/rg2']),
      _chat: async (_o: ChatOpts) => {
        throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
      },
    });
    const row = await rollupRow('atoms');
    expect(row).toBeDefined();
    expect(row!.halt_count).toBe(1);
    expect(row!.round_completed_count).toBe(0);
  });

  test('a rate_limit-streak abort (3 consecutive 429s) does NOT count as a halt', async () => {
    for (const slug of ['note/rr1', 'note/rr2', 'note/rr3', 'note/rr4']) await seedPage(slug);
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: mkPages(['note/rr1', 'note/rr2', 'note/rr3', 'note/rr4']),
      _chat: async (_o: ChatOpts) => {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    });
    const row = await rollupRow('atoms');
    expect(row).toBeDefined();
    expect(row!.halt_count).toBe(0);
    expect(row!.round_completed_count).toBe(1);
  });
});

describe('runPhaseExtractAtoms — completion receipt (gbrain#4148)', () => {
  test('full success flips atoms to the real source_hash and stamps the page', async () => {
    await seedPage('note/ok1');
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'note/ok1', content: 'prose', contentHash: HASH_A }],
      _chat: async (_o: ChatOpts) => okChatResult(ATOM_JSON),
    });
    expect(result.details.atoms_extracted).toBe(1);
    const atoms = await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> | string }>(
      `SELECT slug, frontmatter FROM pages WHERE type = 'atom' AND source_id = 'default'`,
    );
    expect(atoms).toHaveLength(1);
    const afm = typeof atoms[0].frontmatter === 'string' ? JSON.parse(atoms[0].frontmatter) : atoms[0].frontmatter;
    expect(afm.source_hash).toBe(HASH_A); // flipped, not pending:
    expect(String(afm.source_hash)).not.toContain('pending');
    expect((await frontmatterOf('note/ok1')).atoms_scan_hash).toBe(HASH_A);
  });

  test('a pending (partial-persist) atom row does NOT mark the source page done for discovery', async () => {
    // Seed a discovery-eligible source page: extractable type + >=500 chars.
    const longBody = 'meeting prose. '.repeat(60);
    await engine.putPage('meetings/2026-04-03', {
      title: 'meetings/2026-04-03',
      type: 'meeting',
      compiled_truth: longBody,
    } as never, { sourceId: 'default' });
    const pageRow = await engine.executeRaw<{ content_hash: string }>(
      `SELECT content_hash FROM pages WHERE slug = 'meetings/2026-04-03' AND source_id = 'default'`,
    );
    const hash16 = pageRow[0].content_hash.slice(0, 16);

    // An atom left behind by a crashed partial run: provisional hash.
    await engine.putPage('atoms/2026-04-03/partial-atom-abc123', {
      title: 'partial atom',
      type: 'atom',
      compiled_truth: 'atom body',
      frontmatter: { source_hash: `pending:${hash16}` },
    } as never, { sourceId: 'default' });

    const pending = await discoverExtractablePages(engine, 'default');
    expect(pending.map(p => p.slug)).toContain('meetings/2026-04-03'); // still pending → retried

    // After the flip (completed run) the same page is done.
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text)
        WHERE slug = 'atoms/2026-04-03/partial-atom-abc123' AND source_id = 'default'`,
      [hash16],
    );
    const done = await discoverExtractablePages(engine, 'default');
    expect(done.map(p => p.slug)).not.toContain('meetings/2026-04-03');
  });
});
