/**
 * Roadmap PR 2: the session-start sections' plumbing (src/core/context/session-start-sections.ts,
 * composeSessionStartWithSections) and the stdio serve's first-session lane (stdioFirstSessionLane).
 *
 * 1. Protects: sections keep priority order and are kept or dropped whole inside one byte budget; coaching parts
 *    leave the payload only when it then still holds the first-session section whole; the outcome log hashes the
 *    session id, keeps 50 lines and is private to the user; only an unbound stdio serve or one bound to the brain
 *    owner is the owner lane.
 * 2. Fails when: a section is cut in half, coaching goes quiet for a section the payload lost, a raw session id is
 *    written, or a member-bound or read-only serve reads as the owner.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fitSessionStartSections, firstSessionOutcomePath, readFirstSessionOutcomes, recordFirstSessionOutcome, type SessionStartSection } from '../src/core/context/session-start-sections.ts';
import { composeSessionStartWithSections } from '../src/core/context/session-start-output.ts';
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../src/core/bootstrap/host-specs.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addMember, disableMember } from '../src/core/access/members.ts';
import { STDIO_MEMBER_KEY } from '../src/core/access/caller.ts';
import { OWNER_MEMBER_KEY } from '../src/core/search/private-visibility.ts';
import { stdioFirstSessionLane } from '../src/mcp/server.ts';
import { withEnv } from './helpers/with-env.ts';

const first: SessionStartSection = { name: 'first_session', text: '[gbrain] First sessions on this brain (1 of 3):\n- Offer one thing.', receipt: 'tok' };
const learned: SessionStartSection = { name: 'nightly_learning', text: '[gbrain] Learned overnight: 2 facts.' };
const COACH = '[gbrain] Backups: none yet. Run gbrain backup.';

describe('fitSessionStartSections', () => {
  test('priority order, whole sections, one shared budget', () => {
    expect(fitSessionStartSections([learned, first]).kept.map(s => s.name)).toEqual(['first_session', 'nightly_learning']);
    const tight = fitSessionStartSections([learned, first], Buffer.byteLength(first.text) + 5);
    expect(tight.kept).toEqual([first]);
    expect(tight.dropped).toEqual(['nightly_learning']);
    expect(fitSessionStartSections([first], 10)).toEqual({ kept: [], dropped: ['first_session'] });
    expect(fitSessionStartSections([{ name: 'nightly_learning', text: '' }]).kept).toEqual([]);
  });
});

describe('composeSessionStartWithSections', () => {
  test('without a first-session section the coaching part stays and nothing is quiet', () => {
    const out = composeSessionStartWithSections('core', [learned], [COACH], new Set([COACH]));
    expect(out).toMatchObject({ quiet: false, emitted: false });
    expect(out.text).toContain(COACH);
    expect(out.text.indexOf(learned.text)).toBeLessThan(out.text.indexOf(COACH));
  });

  test('with the section, coaching is left out and the section leads the parts', () => {
    const out = composeSessionStartWithSections('core', [first, learned], [COACH, 'pack text'], new Set([COACH]));
    expect(out).toMatchObject({ quiet: true, emitted: true, first });
    expect(out.text).not.toContain(COACH);
    expect(out.text).toContain(first.text);
    expect(out.text).toContain('pack text');
    expect(out.text.indexOf('core')).toBeLessThan(out.text.indexOf(first.text));
  });

  test('a section the cap cut out is not emitted, and coaching is not quieted for it', () => {
    const core = 'c'.repeat(CLAUDE_HOOK_OUTPUT_CAP_CHARS - 20);
    const out = composeSessionStartWithSections(core, [first], [COACH], new Set([COACH]));
    expect(out.emitted).toBe(false);
    expect(out.quiet).toBe(false);
    expect(out.text).not.toContain(first.text);
  });
});

describe('first-session outcome log', () => {
  const home = mkdtempSync(join(tmpdir(), 'gb-fs-outcome-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('hashes the session id, drops a malformed reason, keeps the newest 50 lines, mode 0600', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      recordFirstSessionOutcome({ harness: 'codex', sessionId: 'raw-session-id-canary', outcome: 'not_due', reason: 'Bad Reason With Spaces' });
      const [one] = readFirstSessionOutcomes();
      expect(one).toMatchObject({ harness: 'codex', outcome: 'not_due' });
      expect(one!.reason).toBeUndefined();
      expect(one!.session).toMatch(/^[0-9a-f]{12}$/);
      expect(readFileSync(firstSessionOutcomePath(), 'utf8')).not.toContain('canary');
      expect(statSync(firstSessionOutcomePath()).mode & 0o777).toBe(0o600);
      for (let i = 0; i < 60; i++) recordFirstSessionOutcome({ harness: 'claude-code', sessionId: String(i), outcome: 'delivered', retried: i === 59 });
      const all = readFirstSessionOutcomes();
      expect(all.length).toBe(50);
      expect(all.at(-1)).toMatchObject({ outcome: 'delivered', retried: true });
    });
  });
});

describe('stdioFirstSessionLane', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await addMember(engine, 'alice-example');
    await addMember(engine, 'bob-example');
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('unbound is the owner; read-only never is', async () => {
    expect(await stdioFirstSessionLane(engine, { readOnly: false })).toBe('owner');
    expect(await stdioFirstSessionLane(engine, { readOnly: true })).toBe('read_only');
  });

  test('a binding that cannot be read is never the owner lane', async () => {
    const e = engine;
    const unreadable = new Proxy(e, {
  get(t, k) {
    if (k === 'getConfig') return async (key: string) => { if (key === STDIO_MEMBER_KEY) throw new Error('config read failed'); return t.getConfig(key); };
    const v = (t as unknown as Record<PropertyKey, unknown>)[k];
    return typeof v === 'function' ? v.bind(t) : v;
  },
}) as PGLiteEngine;
    expect(await stdioFirstSessionLane(unreadable, { readOnly: false })).toBe('member');
  });

  test('a member binding is the owner lane only when that member is the brain owner and enabled', async () => {
    await engine.setConfig(STDIO_MEMBER_KEY, 'bob-example');
    expect(await stdioFirstSessionLane(engine, { readOnly: false })).toBe('member');
    await engine.setConfig(OWNER_MEMBER_KEY, 'alice-example');
    expect(await stdioFirstSessionLane(engine, { readOnly: false })).toBe('member');
    expect(await stdioFirstSessionLane(engine, { readOnly: false, stdioMember: 'alice-example' })).toBe('owner');
    await engine.setConfig(STDIO_MEMBER_KEY, 'alice-example');
    expect(await stdioFirstSessionLane(engine, { readOnly: false })).toBe('owner');
    await disableMember(engine, 'alice-example');
    expect(await stdioFirstSessionLane(engine, { readOnly: false })).toBe('member');
  });
});
