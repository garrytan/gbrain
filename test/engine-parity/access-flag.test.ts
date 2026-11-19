/**
 * BrainEngine parity — the sticky member-access flag: a page write whose frontmatter has a top-level
 * `readable_by` key sets config `access.restrictions_present` to '1' (schema migration v282, trigger
 * `pages_access_mark_restricted`), and nothing a later write does clears it.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) a brain whose pages carry no top-level `readable_by` leaves the flag unset
 *    (a nested `readable_by` does not count), the first `readable_by` page sets it to '1', and it stays '1' after the
 *    page drops the key or is soft-deleted.
 *  - Regression: search/private-visibility.ts skips the member-access filter on a brain whose flag is unset. An
 *    engine that never sets the flag serves a `readable_by` page to every member.
 *  - Why existing coverage misses it: the flag is written by a SQL trigger, so no engine member names it and the
 *    method coverage table cannot see it.
 *  - Seam: none. Typed members only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const FLAG = 'access.restrictions_present';
const NOTE = { type: 'note' as const, title: 'Access note', compiled_truth: 'body', timeline: '' };

describe('engine parity: member-access flag', () => {
  parityTest('a readable_by page write sets access.restrictions_present, and the flag stays set', {
    methods: ['putPage', 'softDeletePage', 'getConfig'],
  }, async (engine) => {
    await engine.putPage('notes/access-open', { ...NOTE, frontmatter: { tags: ['a'], meta: { readable_by: ['x'] } } });
    const beforeRestricted = await engine.getConfig(FLAG);
    await engine.putPage('notes/access-closed', { ...NOTE, frontmatter: { readable_by: ['alice-example'] } });
    const afterRestricted = await engine.getConfig(FLAG);
    await engine.putPage('notes/access-closed', { ...NOTE, frontmatter: {} });
    await engine.softDeletePage('notes/access-closed');
    const afterCleared = await engine.getConfig(FLAG);
    expect(beforeRestricted).toBeNull();
    expect(afterRestricted).toBe('1');
    expect(afterCleared).toBe('1');
    return { beforeRestricted, afterRestricted, afterCleared };
  });
});
