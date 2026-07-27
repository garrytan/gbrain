/**
 * v0.43 (#2095) — push-based context core: window parsing, multi-turn
 * extraction, confidence-gated volunteering, slug-only suppression, privacy,
 * and the usage-stats join. Hermetic in-memory PGLite (no file lock),
 * modeled on test/retrieval-reflex.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { normalizeAlias } from '../src/core/search/alias-normalize.ts';
import {
  extractCandidatesFromWindow,
  MAX_CANDIDATES,
  type WindowTurn,
} from '../src/core/context/entity-salience.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import {
  parseWindow,
  volunteerContext,
  volunteerUsageStats,
  VOLUNTEER_DEFAULT_MIN_CONFIDENCE,
} from '../src/core/context/volunteer.ts';
import { insertVolunteerEvents } from '../src/core/context/volunteer-events.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;

async function seed(slug: string, title: string, body: string, source = 'default') {
  if (source !== 'default') {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [source, `/tmp/${source}`],
    );
  }
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, $2, 'person', $3, $4, '')`,
    [slug, source, title, body],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM page_aliases').catch(() => {});
  await engine.executeRaw('DELETE FROM context_volunteer_events').catch(() => {});
  await engine.executeRaw('DELETE FROM pages');
});

describe('parseWindow', () => {
  test('role prefixes split turns oldest → newest', () => {
    const turns = parseWindow('user: ask Alice about the deal\nassistant: noted\nuser: what did she say?');
    expect(turns).toEqual([
      { role: 'user', text: 'ask Alice about the deal' },
      { role: 'assistant', text: 'noted' },
      { role: 'user', text: 'what did she say?' },
    ]);
  });

  test('CRLF input parses identically', () => {
    const turns = parseWindow('user: hello\r\nassistant: hi\r\n');
    expect(turns).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
    ]);
  });

  test('unprefixed text is ONE user turn (echo | volunteer-context just works)', () => {
    const turns = parseWindow('met with Alice Example today\nshe asked about acme');
    expect(turns).toEqual([{ role: 'user', text: 'met with Alice Example today\nshe asked about acme' }]);
  });

  test('continuation lines append to the open turn', () => {
    const turns = parseWindow('user: first line\nsecond line\nassistant: ok');
    expect(turns[0]).toEqual({ role: 'user', text: 'first line\nsecond line' });
    expect(turns[1]).toEqual({ role: 'assistant', text: 'ok' });
  });

  test('empty / whitespace input → []', () => {
    expect(parseWindow('')).toEqual([]);
    expect(parseWindow('   \n  \n')).toEqual([]);
  });
});

describe('extractCandidatesFromWindow', () => {
  test('merges across turns with occurrence + newest-turn metadata', () => {
    const turns: WindowTurn[] = [
      { role: 'user', text: 'ask Alice Example about the deal' },
      { role: 'assistant', text: 'Alice Example said she will follow up' },
      { role: 'user', text: 'and ping Bob Sample too' },
    ];
    const cands = extractCandidatesFromWindow(turns);
    const alice = cands.find((c) => normalizeAlias(c.query) === normalizeAlias('Alice Example'));
    const bob = cands.find((c) => normalizeAlias(c.query) === normalizeAlias('Bob Sample'));
    expect(alice).toBeDefined();
    expect(alice!.occurrences).toBe(2);
    expect(alice!.inNewestTurn).toBe(false);
    expect(alice!.userMention).toBe(true);
    expect(bob).toBeDefined();
    expect(bob!.inNewestTurn).toBe(true);
  });

  test('assistant-only mention is flagged (userMention=false)', () => {
    const cands = extractCandidatesFromWindow([
      { role: 'assistant', text: 'You should talk to Charlie Demo about this' },
      { role: 'user', text: 'good idea' },
    ]);
    const charlie = cands.find((c) => normalizeAlias(c.query) === normalizeAlias('Charlie Demo'));
    expect(charlie).toBeDefined();
    expect(charlie!.userMention).toBe(false);
  });

  test('cap holds across a noisy window', () => {
    const noisy = Array.from({ length: 30 }, (_, i) => `Entity Number${i} did something.`).join(' ');
    const cands = extractCandidatesFromWindow([{ role: 'user', text: noisy }]);
    expect(cands.length).toBeLessThanOrEqual(MAX_CANDIDATES);
  });
});

describe('volunteerContext', () => {
  test('assistant-introduced entity two turns back resolves on a pronoun follow-up', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is an early founder.');
    const turns = parseWindow(
      'user: who should I talk to about the seed round?\n' +
      'assistant: Alice Example led a similar round last year.\n' +
      'user: what did she invest in?',
    );
    const pages = await volunteerContext(engine, turns, { sourceIds: ['default'] });
    expect(pages.length).toBe(1);
    expect(pages[0].slug).toBe('people/alice-example');
    expect(pages[0].arm).toBe('title');
    expect(pages[0].rationale).toContain('assistant-introduced');
  });

  test('excludeSlugs skips BEFORE the cap: an excluded entity never starves a fresh page', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    await seed('people/bob-sample', 'Bob Sample', 'Engineer.');
    const turns = parseWindow('user: intro Alice Example to Bob Sample');
    const pages = await volunteerContext(engine, turns, {
      sourceIds: ['default'],
      maxPages: 1,
      excludeSlugs: new Set(['people/alice-example']),
    });
    // A post-call filter would return [] here (Alice burns the single cap
    // slot, then gets filtered). The pre-cap exclusion hands Bob the slot.
    expect(pages.length).toBe(1);
    expect(pages[0].slug).toBe('people/bob-sample');
  });

  test('confidence gate drops slug-suffix matches at the default threshold', async () => {
    // Page resolvable ONLY via slug-suffix: title differs from the mention.
    await seed('projects/widget-co', 'The Widget Company Project', 'A project page.');
    const turns = parseWindow('user: any updates on Widget-Co this week?');
    const gated = await volunteerContext(engine, turns, { sourceIds: ['default'] });
    expect(gated).toEqual([]);
    // Lowering min_confidence lets it through with honest provenance.
    const loose = await volunteerContext(engine, turns, { sourceIds: ['default'], minConfidence: 0.5 });
    expect(loose.length).toBe(1);
    expect(loose[0].arm).toBe('slug-suffix');
    expect(loose[0].confidence).toBeLessThan(VOLUNTEER_DEFAULT_MIN_CONFIDENCE);
  });

  test('alias arm volunteers with boost when mentioned in the newest turn', async () => {
    await seed('people/swami-x', 'Swami X', 'A close friend.');
    await engine.setPageAliases('people/swami-x', 'default', [normalizeAlias('Swami')]);
    const pages = await volunteerContext(
      engine,
      parseWindow('user: Spoke with Swami today'),
      { sourceIds: ['default'] },
    );
    expect(pages.length).toBe(1);
    expect(pages[0].arm).toBe('alias');
    expect(pages[0].confidence).toBeCloseTo(0.95, 5); // 0.9 + newest-turn boost
    expect(pages[0].rationale).toContain('alias match');
  });

  test('suppression is slug-only under windowing: a prior-turn MENTION does not suppress', async () => {
    await seed('people/alice-example', 'Alice Example', 'A founder.');
    // Prior context contains the TITLE (a bare mention from an earlier turn)
    // but NOT the slug — the page was never actually surfaced.
    const pages = await volunteerContext(
      engine,
      parseWindow('user: ping Alice Example again'),
      { sourceIds: ['default'], priorContext: 'earlier the user said: tell Alice Example the news' },
    );
    expect(pages.length).toBe(1);
    // A slug in prior context (the page WAS surfaced) does suppress.
    const suppressed = await volunteerContext(
      engine,
      parseWindow('user: ping Alice Example again'),
      { sourceIds: ['default'], priorContext: 'pointer: people/alice-example was injected last turn' },
    );
    expect(suppressed).toEqual([]);
  });

  test('privacy: takes-fence content never leaks into the synopsis', async () => {
    const body = `${TAKES_FENCE_BEGIN}\nSECRET_HUNCH_DO_NOT_LEAK\n${TAKES_FENCE_END}\nAlice is a founder.`;
    await seed('people/alice-example', 'Alice Example', body);
    const pages = await volunteerContext(engine, parseWindow('user: about Alice Example'), { sourceIds: ['default'] });
    expect(pages.length).toBe(1);
    expect(JSON.stringify(pages)).not.toContain('SECRET_HUNCH_DO_NOT_LEAK');
  });

  test('multi-source scope: resolves from both sources, never outside the scope', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.', 'default');
    await seed('people/bob-sample', 'Bob Sample', 'Engineer.', 'team-brain');
    await seed('people/eve-other', 'Eve Other', 'Out of scope.', 'private-brain');
    const turns = parseWindow('user: intro Alice Example to Bob Sample and Eve Other');
    const pages = await volunteerContext(engine, turns, { sourceIds: ['default', 'team-brain'] });
    const keys = pages.map((p) => `${p.source_id}:${p.slug}`).sort();
    expect(keys).toEqual(['default:people/alice-example', 'team-brain:people/bob-sample']);
  });

  test('zero-candidate fast path: no entities → [] without touching resolution', async () => {
    const pages = await volunteerContext(engine, parseWindow('user: ok thanks, sounds good'), {
      sourceIds: ['default'],
    });
    expect(pages).toEqual([]);
  });

  test('max_pages caps at 5 even when asked for more', async () => {
    for (let i = 0; i < 8; i++) {
      await seed(`people/person-${i}`, `Person Alpha${i}`, 'A person.');
    }
    const text = Array.from({ length: 8 }, (_, i) => `Person Alpha${i}`).join(' and ');
    const pages = await volunteerContext(engine, parseWindow(`user: intro ${text}`), {
      sourceIds: ['default'],
      maxPages: 50,
    });
    expect(pages.length).toBeLessThanOrEqual(5);
  });
});

describe('volunteerUsageStats', () => {
  test('join math: used = last_retrieved_at > volunteered_at, labeled approximate', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    await seed('people/bob-sample', 'Bob Sample', 'Engineer.');
    await insertVolunteerEvents(engine, [
      { source_id: 'default', slug: 'people/alice-example', confidence: 0.9, match_arm: 'alias', rationale: 'r', channel: 'op' },
      { source_id: 'default', slug: 'people/bob-sample', confidence: 0.8, match_arm: 'title', rationale: 'r', channel: 'op' },
    ]);
    // Alice was opened AFTER being volunteered; Bob never was.
    await engine.executeRaw(
      `UPDATE pages SET last_retrieved_at = now() + interval '1 minute' WHERE slug = 'people/alice-example'`, [],
    );
    const stats = await volunteerUsageStats(engine, ['default'], 30);
    expect(stats.approximate).toBe(true);
    expect(stats.note).toContain('approximate');
    expect(stats.total_volunteered).toBe(2);
    expect(stats.total_used).toBe(1);
    const alias = stats.by_arm.find((a) => a.match_arm === 'alias')!;
    expect(alias.used).toBe(1);
    expect(alias.precision).toBe(1);
    const title = stats.by_arm.find((a) => a.match_arm === 'title')!;
    expect(title.used).toBe(0);
  });

  test('zero events → zeroed stats, not an error', async () => {
    const stats = await volunteerUsageStats(engine, ['default'], 7);
    expect(stats.total_volunteered).toBe(0);
    expect(stats.by_arm).toEqual([]);
  });
});

describe('resolveEntitiesToPointers — new provenance surface (back-compat)', () => {
  test('pointers carry arm + confidence + source_id', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    const block = await resolveEntitiesToPointers(
      engine,
      'default',
      [{ display: 'Alice Example', query: 'Alice Example' }],
      {},
    );
    expect(block).not.toBeNull();
    expect(block!.pointers[0].arm).toBe('title');
    expect(block!.pointers[0].confidence).toBe(0.8);
    expect(block!.pointers[0].source_id).toBe('default');
  });

  test('legacy suppression (slug-and-title) still drops a title mention in prior context', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    const block = await resolveEntitiesToPointers(
      engine,
      'default',
      [{ display: 'Alice Example', query: 'Alice Example' }],
      { priorContextText: 'we discussed Alice Example earlier' },
    );
    expect(block).toBeNull();
  });
});

describe('volunteer_context op (contract surface)', () => {
  const { operationsByName } = require('../src/core/operations.ts') as typeof import('../src/core/operations.ts');
  const {
    awaitPendingVolunteerEventWrites,
    _resetPendingVolunteerEventWritesForTests,
  } = require('../src/core/context/volunteer-events.ts') as typeof import('../src/core/context/volunteer-events.ts');

  function mkCtx(overrides: Record<string, unknown> = {}) {
    return {
      engine,
      config: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      dryRun: false,
      remote: false,
      sourceId: 'default',
      ...overrides,
    } as never;
  }

  test('registered, read-scope, not localOnly, stdin cliHint on window', () => {
    const op = operationsByName.volunteer_context;
    expect(op).toBeDefined();
    expect(op.scope).toBe('read');
    expect(op.localOnly).toBeFalsy();
    expect(op.cliHints?.name).toBe('volunteer-context');
    expect(op.cliHints?.stdin).toBe('window');
  });

  test('window required unless stats: true', async () => {
    const op = operationsByName.volunteer_context;
    await expect(op.handler(mkCtx(), {})).rejects.toThrow(/window is required/);
    const stats = (await op.handler(mkCtx(), { stats: true })) as any;
    expect(stats.approximate).toBe(true);
  });

  test('volunteers pages and logs events through the drained sink', async () => {
    _resetPendingVolunteerEventWritesForTests();
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    const op = operationsByName.volunteer_context;
    const result = (await op.handler(mkCtx(), {
      window: 'user: ping Alice Example about the deal',
      session_id: 's-42',
      turn: 7,
    })) as any;
    expect(result.count).toBe(1);
    expect(result.pages[0].slug).toBe('people/alice-example');
    expect(result.window_turns).toBe(1);
    // Event row lands via the fire-and-forget sink once drained.
    const { unfinished } = await awaitPendingVolunteerEventWrites(5_000);
    expect(unfinished).toBe(0);
    const rows = await engine.executeRaw<{ slug: string; channel: string; session_id: string; turn: number }>(
      `SELECT slug, channel, session_id, turn FROM context_volunteer_events`, [],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe('people/alice-example');
    expect(rows[0].channel).toBe('op');
    expect(rows[0].session_id).toBe('s-42');
    expect(Number(rows[0].turn)).toBe(7);
  });

  test('event-log failure never fails the op (failing engine injected for the INSERT)', async () => {
    _resetPendingVolunteerEventWritesForTests();
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    const op = operationsByName.volunteer_context;
    // Wrap the engine: reads pass through, INSERTs into the events table throw.
    const failingEngine = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') {
          return (sql: string, params: unknown[]) => {
            if (/INSERT INTO context_volunteer_events/.test(sql)) {
              return Promise.reject(new Error('telemetry db down'));
            }
            return target.executeRaw(sql, params);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = (await op.handler(mkCtx({ engine: failingEngine }), {
      window: 'user: ping Alice Example',
    })) as any;
    expect(result.count).toBe(1); // the volunteer result is unaffected
    const { unfinished } = await awaitPendingVolunteerEventWrites(5_000);
    expect(unfinished).toBe(0); // failed write settled (swallowed), not stuck
  });

  test('federated grant scopes the volunteer (allowedSources)', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.', 'default');
    await seed('people/bob-sample', 'Bob Sample', 'Engineer.', 'grant-brain');
    await seed('people/eve-other', 'Eve Other', 'Out of grant.', 'secret-brain');
    const op = operationsByName.volunteer_context;
    const result = (await op.handler(
      mkCtx({ remote: true, auth: { allowedSources: ['grant-brain'] } }),
      { window: 'user: intro Alice Example to Bob Sample and Eve Other' },
    )) as any;
    expect(result.pages.map((p: any) => p.slug)).toEqual(['people/bob-sample']);
  });

  test('stats mode is source-scoped and returns the approximate note', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    await insertVolunteerEvents(engine, [
      { source_id: 'default', slug: 'people/alice-example', confidence: 0.9, match_arm: 'alias', rationale: 'r', channel: 'watch' },
    ]);
    const op = operationsByName.volunteer_context;
    const stats = (await op.handler(mkCtx(), { stats: true, days: 7 })) as any;
    expect(stats.days).toBe(7);
    expect(stats.total_volunteered).toBe(1);
    expect(stats.by_arm[0].channel).toBe('watch');
    expect(stats.note).toContain('approximate');
  });
});

describe('knob clamps — untrusted MCP caller inputs (review hardening)', () => {
  test('minConfidence outside [0,1] (or NaN) falls back to the 0.7 default gate', async () => {
    await seed('projects/widget-co', 'The Widget Company Project', 'A project.');
    const turns = parseWindow('user: updates on Widget-Co?');
    for (const bad of [5, -1, Number.NaN]) {
      const pages = await volunteerContext(engine, turns, { sourceIds: ['default'], minConfidence: bad });
      expect(pages).toEqual([]); // slug-suffix (0.6+boost) stays gated at the default 0.7
    }
  });

  test('maxPages 0 / negative / NaN fall back to the 3-page default', async () => {
    for (let i = 0; i < 5; i++) await seed(`people/person-${i}`, `Person Alpha${i}`, 'A person.');
    const text = Array.from({ length: 5 }, (_, i) => `Person Alpha${i}`).join(' and ');
    for (const bad of [0, -3, Number.NaN]) {
      const pages = await volunteerContext(engine, parseWindow(`user: intro ${text}`), {
        sourceIds: ['default'],
        maxPages: bad,
      });
      expect(pages.length).toBeLessThanOrEqual(3);
      expect(pages.length).toBeGreaterThan(0);
    }
  });

  test('stats days <= 0 / NaN falls back to 30', async () => {
    const stats = await volunteerUsageStats(engine, ['default'], -5);
    expect(stats.days).toBe(30);
    const stats2 = await volunteerUsageStats(engine, ['default'], Number.NaN);
    expect(stats2.days).toBe(30);
  });
});

describe('window-cap ordering — the newest user mention survives the cap', () => {
  test('stale assistant-only chatter is dropped before a newest-turn user entity', async () => {
    const { extractCandidatesFromWindow: extract, MAX_CANDIDATES: CAP } = await import('../src/core/context/entity-salience.ts');
    // 14 stale assistant-introduced entities in turn 1, then the user names
    // ONE entity in the newest turn. The cap (12) must keep the user's.
    const stale = Array.from({ length: 14 }, (_, i) => `Stale Chatter${i}`).join(', ');
    const cands = extract([
      { role: 'assistant', text: `consider ${stale}.` },
      { role: 'user', text: 'actually ask Alice Example first' },
    ]);
    expect(cands.length).toBeLessThanOrEqual(CAP);
    const alice = cands.find((c) => normalizeAlias(c.query) === normalizeAlias('Alice Example'));
    expect(alice).toBeDefined();
    // Recency + user-role weighting puts the newest user mention FIRST.
    expect(normalizeAlias(cands[0].query)).toBe(normalizeAlias('Alice Example'));
  });
});

describe('volunteer-events sink — timeout branch (long-lived process safety)', () => {
  test('a hung write reports unfinished and drops the snapshot (no ghost references)', async () => {
    const {
      logVolunteerEventsFireAndForget,
      awaitPendingVolunteerEventWrites,
      _resetPendingVolunteerEventWritesForTests,
      _peekPendingVolunteerEventWritesForTests,
    } = await import('../src/core/context/volunteer-events.ts');
    _resetPendingVolunteerEventWritesForTests();
    const hangingEngine = {
      executeRaw: () => new Promise(() => { /* never settles */ }),
    } as never;
    logVolunteerEventsFireAndForget(hangingEngine, [
      { source_id: 'default', slug: 'people/x', confidence: 0.9, match_arm: 'alias', rationale: 'r', channel: 'watch' },
    ]);
    const { unfinished } = await awaitPendingVolunteerEventWrites(20);
    expect(unfinished).toBe(1);
    // Snapshot dropped so a long-lived `gbrain watch` never accumulates
    // references to forever-pending work (the last-retrieved C1 class).
    expect(_peekPendingVolunteerEventWritesForTests()).toBe(0);
    _resetPendingVolunteerEventWritesForTests();
  });
});
