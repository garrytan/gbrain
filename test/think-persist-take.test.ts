/**
 * #2556 — `gbrain think --take` actually persists a take row.
 *
 * The flag was documented + parsed + remote-gated since v0.28, but
 * RunThinkOpts.take was never read: no think path called addTakeToPage, so
 * `--take` silently persisted nothing. persistTakeFromSynthesis is the
 * missing execution half; these tests pin:
 *
 *   1. claimFromAnswer: first substantive line, gaps stripped, markdown
 *      markers removed, fence-cell sanitization, bounded length.
 *   2. Happy path on PGLite + a tmp brain repo: fence row lands on DISK
 *      (md-first) AND the DB mirror row exists; take_row returned.
 *   3. Warning paths: synthesisOk=false, empty answer, no brain repo
 *      (TAKE_MIRROR_UNAVAILABLE), missing anchor page (TAKE_WRITE_FAILED).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  claimFromAnswer,
  persistTakeFromSynthesis,
  TAKE_CLAIM_MAX_CHARS,
} from '../src/core/think/persist-take.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-2556-'));
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (brainDir) rmSync(brainDir, { recursive: true, force: true });
}, 60_000);

describe('#2556 claimFromAnswer (pure)', () => {
  test('takes the first substantive line and strips markdown markers', () => {
    expect(claimFromAnswer('## Verdict\n\n- Alice is the strongest founder in the batch.\nMore detail.'))
      .toBe('Verdict');
    expect(claimFromAnswer('\n\n- Alice is the strongest founder in the batch.\nMore.'))
      .toBe('Alice is the strongest founder in the batch.');
  });

  test('strips the Gaps section before extracting', () => {
    const answer = '## Gaps\n- missing data\n\n## Answer\nThe real claim.';
    // stripGapsSection removes ONLY the gaps block; the next line wins.
    expect(claimFromAnswer(answer)).toBe('Answer');
  });

  test('sanitizes fence-hostile content to a single safe cell', () => {
    expect(claimFromAnswer('claim with\ttabs and gbrain:takes marker')).toBe('claim with tabs and marker');
    // Wholly-strikethrough would round-trip inactive — unwrapped.
    expect(claimFromAnswer('~~struck claim~~')).toBe('struck claim');
  });

  test('bounds the claim length', () => {
    const long = 'x'.repeat(TAKE_CLAIM_MAX_CHARS * 2);
    const claim = claimFromAnswer(long)!;
    expect(claim.length).toBeLessThanOrEqual(TAKE_CLAIM_MAX_CHARS);
  });

  test('returns null for empty/whitespace answers', () => {
    expect(claimFromAnswer('')).toBeNull();
    expect(claimFromAnswer('\n\n   \n')).toBeNull();
  });
});

describe('#2556 persistTakeFromSynthesis (PGLite + tmp repo)', () => {
  test('synthesisOk=false warn-skips (never mints a take from a stub)', async () => {
    const r = await persistTakeFromSynthesis(engine, { answer: 'stub', synthesisOk: false }, { anchor: 'x' });
    expect(r.take_row).toBeNull();
    expect(r.warnings).toContain('TAKE_SKIPPED_SYNTHESIS_FAILED');
  });

  test('empty answer warn-skips', async () => {
    const r = await persistTakeFromSynthesis(engine, { answer: '   ', synthesisOk: true }, { anchor: 'x' });
    expect(r.take_row).toBeNull();
    expect(r.warnings).toContain('TAKE_SKIPPED_EMPTY_ANSWER');
  });

  test('no brain repo → TAKE_MIRROR_UNAVAILABLE (md is canonical)', async () => {
    // sync.repo_path unset at this point.
    const r = await persistTakeFromSynthesis(engine, { answer: 'A real claim.', synthesisOk: true }, { anchor: 'x' });
    expect(r.take_row).toBeNull();
    expect(r.warnings).toContain('TAKE_MIRROR_UNAVAILABLE');
  });

  test('happy path: fence row on disk + DB mirror row + take_row', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    await engine.putPage('people/alice-example', {
      type: 'person' as never,
      title: 'Alice Example',
      compiled_truth: 'A founder page.',
    });

    const r = await persistTakeFromSynthesis(
      engine,
      { answer: '- Alice is the strongest founder in the batch.\n\nDetail follows.', synthesisOk: true },
      { anchor: 'people/alice-example' },
    );
    expect(r.warnings.filter(w => w.startsWith('TAKE_'))).toEqual([]);
    expect(r.take_row).toBe(1);
    expect(r.path).toBeDefined();

    // md-first: the fence row is on disk.
    expect(existsSync(r.path!)).toBe(true);
    const body = readFileSync(r.path!, 'utf-8');
    expect(body).toContain('gbrain:takes');
    expect(body).toContain('Alice is the strongest founder in the batch.');

    // DB mirror row exists with the owner holder + think source.
    const rows = await engine.executeRaw<{ claim: string; holder: string; kind: string; source: string | null }>(
      `SELECT t.claim, t.holder, t.kind, t.source
         FROM takes t JOIN pages p ON p.id = t.page_id
        WHERE p.slug = 'people/alice-example' AND p.source_id = 'default'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.claim).toBe('Alice is the strongest founder in the batch.');
    expect(rows[0]!.kind).toBe('take');
    expect(rows[0]!.source).toBe('think');
  }, 60_000);

  test('missing anchor page → TAKE_WRITE_FAILED warning, never a throw', async () => {
    const r = await persistTakeFromSynthesis(
      engine,
      { answer: 'A claim.', synthesisOk: true },
      { anchor: 'people/no-such-page' },
    );
    expect(r.take_row).toBeNull();
    expect(r.warnings.some(w => w.startsWith('TAKE_WRITE_FAILED'))).toBe(true);
  }, 60_000);
});
