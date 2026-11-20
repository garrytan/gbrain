/**
 * The Rust census normaliser (scripts/rust-census/normalize.ts) on opaque cursors.
 *
 * 1. Contract: two brains seeded from the same fixture answer `delta --json` with a `next_cursor` that differs only
 *    by the clock inside it, so the census must call that row equal; a cursor whose non-clock content differs (a
 *    slug, a fact id, a listing key) must still compare as different.
 * 2. Regression that fails it: the normaliser comparing the base64url token as plain text (it hides clocks only in
 *    plain values), which marks `cli delta` "differs" on every arm, Postgres included, with nothing wrong in an engine.
 * 3. Existing coverage: none; the census script had no test, and engine parity tests never see a CLI cursor.
 * 4. Production seam: none; the normaliser is a census module and the cursors come from the real encoders.
 */
import { describe, expect, test } from 'bun:test';
import { normalize } from '../scripts/rust-census/normalize.ts';
import { encodeDeltaCursor } from '../src/core/context/delta-cursor.ts';
import { encodeListingCursor } from '../src/core/bounded-listing.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(normalize(a, [])) === JSON.stringify(normalize(b, []));
const delta = (since: string, slug: string, at: string, id: number | null) =>
  encodeDeltaCursor({ pages: { since, slug }, facts: { at, id } });
const b64url = (v: unknown, prefix = '') => prefix + Buffer.from(JSON.stringify(v)).toString('base64url');

describe('census normaliser on opaque cursors', () => {
  test('a delta next_cursor that differs only by the clocks inside it compares equal', () => {
    const a = { next_cursor: delta('2026-11-19T06:01:02.123456Z', 'people/alice-example', '2026-11-19T06:01:03.000001Z', 4) };
    const b = { next_cursor: delta('2026-11-19T07:44:55.654321Z', 'people/alice-example', '2026-11-19T07:44:56.000002Z', 4) };
    expect(a.next_cursor).not.toBe(b.next_cursor);
    expect(same(a, b)).toBe(true);
  });

  test('a delta cursor with a different slug or fact id still differs', () => {
    const base = delta('2026-11-19T06:01:02.123456Z', 'people/alice-example', '2026-11-19T06:01:03Z', 4);
    expect(same({ next_cursor: base }, { next_cursor: delta('2026-11-19T07:00:00Z', 'people/bob-example', '2026-11-19T06:01:03Z', 4) })).toBe(false);
    expect(same({ next_cursor: base }, { next_cursor: delta('2026-11-19T06:01:02.123456Z', 'people/alice-example', '2026-11-19T06:01:03Z', 5) })).toBe(false);
  });

  test('other base64url cursors, prefixed or not, mask their clocks and keep the rest', () => {
    const listing = (t: string, slug: string) => encodeListingCursor('pages', [t, slug]);
    expect(same({ cursor: listing('2026-11-19T06:00:00Z', 'a') }, { cursor: listing('2026-11-20T01:02:03Z', 'a') })).toBe(true);
    expect(same({ cursor: listing('2026-11-19T06:00:00Z', 'a') }, { cursor: listing('2026-11-19T06:00:00Z', 'b') })).toBe(false);
    expect(same([b64url({ i: 3, at: '2026-11-19T06:00:00Z' }, 'lk1.')], [b64url({ i: 3, at: '2026-11-21T06:00:00Z' }, 'lk1.')])).toBe(true);
    expect(same([b64url({ i: 3 }, 'lk1.')], [b64url({ i: 3 }, 'gpw1.')])).toBe(false);
  });

  test('plain strings that are not encoded JSON stay as they were', () => {
    for (const s of ['people/alice-example', 'abcdefgh', 'eyJub3QganNvbg', 'SGVsbG8gd29ybGQ']) expect(normalize(s, [])).toBe(s);
  });
});

describe('census normaliser on serve PIDs in notice text', () => {
  // A readiness notice names the stdio serve that holds the brain: `fix: kill <pid>` and "(PID <pid>)". Each arm
  // runs its own serve, so only the number may differ; the `pid` key rule masks it in JSON but not inside text.
  const notice = (pid: number) => `fix: kill ${pid}\nuser_message: Please stop the stdio \`gbrain serve\` an agent session started (PID ${pid}), then retry.`;

  test('a notice that differs only by the serve PID compares equal', () => {
    expect(same({ content: notice(2826684) }, { content: notice(41) })).toBe(true);
    expect(normalize(notice(7), [])).toBe('fix: kill <pid>\nuser_message: Please stop the stdio `gbrain serve` an agent session started (PID <pid>), then retry.');
  });

  test('numbers in any other text form still compare', () => {
    expect(same({ content: 'killed 3 jobs' }, { content: 'killed 4 jobs' })).toBe(false);
    expect(same({ content: 'pid 3' }, { content: 'pid 4' })).toBe(false);
    expect(same({ content: 'PIDs 3' }, { content: 'PIDs 4' })).toBe(false);
    expect(same({ content: 'skill 3' }, { content: 'skill 4' })).toBe(false);
    expect(same({ content: 'kill -9 3' }, { content: 'kill -9 4' })).toBe(false);
    expect(same({ content: 'fix: kill 3\nretry 1' }, { content: 'fix: kill 4\nretry 2' })).toBe(false);
  });
});
