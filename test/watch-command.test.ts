/**
 * v0.43 (#2095) — `gbrain watch` push transport: streaming loop, rolling
 * window, session dedupe, --json shape, event logging on channel 'watch',
 * and clean EOF return. Hermetic PGLite + injected line/write deps (no
 * subprocess, no real stdin).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runWatch, WATCH_HELP } from '../src/commands/watch.ts';
import { awaitPendingVolunteerEventWrites, _resetPendingVolunteerEventWritesForTests } from '../src/core/context/volunteer-events.ts';

let engine: PGLiteEngine;

async function seed(slug: string, title: string, body: string) {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, 'default', 'person', $2, $3, '')`,
    [slug, title, body],
  );
}

async function* feed(lines: string[]): AsyncGenerator<string> {
  for (const l of lines) yield l;
}

async function watchRun(lines: string[], extraArgs: string[] = []): Promise<string[]> {
  const out: string[] = [];
  await runWatch(engine, ['--source', 'default', ...extraArgs], {
    lines: feed(lines),
    write: (s) => out.push(s),
    isTTY: false,
  });
  return out;
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
  _resetPendingVolunteerEventWritesForTests();
  await engine.executeRaw('DELETE FROM context_volunteer_events').catch(() => {});
  await engine.executeRaw('DELETE FROM pages');
});

describe('gbrain watch (#2095)', () => {
  test('--help prints WATCH_HELP and touches nothing', async () => {
    const out = await watchRun([], ['--help']);
    expect(out.join('')).toBe(WATCH_HELP);
  });

  test('volunteers per turn and returns cleanly at EOF', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    const out = await watchRun(['ping Alice Example about the deal']);
    const text = out.join('');
    expect(text).toContain('people/alice-example');
    expect(text).toContain('exact title match');
    // runWatch RESOLVED — the EOF → clean-return contract (the entrypoint
    // flush-exit + finally drain handle the rest in the real CLI).
  });

  test('rolling window: assistant-introduced entity fires on the pronoun follow-up turn', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    const out = await watchRun([
      'user: who should I ask about the round?',
      'assistant: Alice Example led one last year.',
      'user: what did she invest in?',
    ]);
    expect(out.join('')).toContain('people/alice-example');
  });

  test('session dedupe: a slug is volunteered at most once per session', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    const out = await watchRun([
      'user: ping Alice Example',
      'user: ok',
      'user: Alice Example again please',
    ]);
    const hits = out.join('').split('people/alice-example').length - 1;
    expect(hits).toBe(1);
  });

  test('--json emits one JSONL row per volunteered page with turn attribution', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    const out = await watchRun(['user: hello there', 'user: ping Alice Example'], ['--json']);
    expect(out.length).toBe(1);
    const row = JSON.parse(out[0]);
    expect(row.slug).toBe('people/alice-example');
    expect(row.turn).toBe(2);
    expect(row.arm).toBe('title');
    expect(typeof row.confidence).toBe('number');
  });

  test('events land on channel watch with session_id + turn (drained sink)', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    await watchRun(['user: ping Alice Example']);
    const { unfinished } = await awaitPendingVolunteerEventWrites(5_000);
    expect(unfinished).toBe(0);
    const rows = await engine.executeRaw<{ channel: string; session_id: string; turn: number }>(
      `SELECT channel, session_id, turn FROM context_volunteer_events`, [],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].channel).toBe('watch');
    expect(rows[0].session_id).toMatch(/^watch-/);
    expect(Number(rows[0].turn)).toBe(1);
  });

  test('min-confidence flag gates exactly like the op', async () => {
    await seed('projects/widget-co', 'The Widget Company Project', 'A project.');
    const gated = await watchRun(['user: updates on Widget-Co?']);
    expect(gated.join('')).toBe('');
    const loose = await watchRun(['user: updates on Widget-Co?'], ['--min-confidence', '0.5']);
    expect(loose.join('')).toContain('projects/widget-co');
  });

  test('blank lines and CRLF are tolerated; no turn, no volunteer', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    const out = await watchRun(['', '   ', 'user: ping Alice Example\r']);
    expect(out.join('')).toContain('people/alice-example');
  });
});

describe('gbrain watch — window + cap flags (ship coverage G4)', () => {
  test('--window-turns 1: fires on the mention turn itself; the pronoun follow-up adds nothing', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    const out = await watchRun(
      [
        'assistant: Alice Example led one last year.',
        'user: what did she invest in?',
      ],
      ['--window-turns', '1', '--json'],
    );
    // Watch volunteers per turn: the entity fires at turn 1 (its mention
    // turn). With window=1 the follow-up turn extracts nothing, so exactly
    // one row exists and it carries turn 1 attribution.
    expect(out.length).toBe(1);
    expect(JSON.parse(out[0]).turn).toBe(1);
  });

  test('--max-pages 1 caps a multi-entity turn to one volunteered page', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    await seed('people/bob-sample', 'Bob Sample', 'Engineer.');
    const out = await watchRun(
      ['user: intro Alice Example to Bob Sample'],
      ['--max-pages', '1', '--json'],
    );
    expect(out.length).toBe(1);
  });
});

describe('gbrain watch — red-team hardening', () => {
  test('starvation guard: an already-pushed slug never burns the --max-pages cap slot', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    await seed('people/bob-sample', 'Bob Sample', 'Engineer.');
    const out = await watchRun(
      [
        'user: ping Alice Example about the round',
        'user: also intro Alice Example to Bob Sample',
      ],
      ['--max-pages', '1', '--json'],
    );
    // Turn 1: Alice takes the single cap slot. Turn 2: Alice is excluded
    // BEFORE the cap (not filtered after), so Bob gets the slot instead of
    // the turn volunteering nothing forever.
    expect(out.length).toBe(2);
    expect(JSON.parse(out[0]).slug).toBe('people/alice-example');
    expect(JSON.parse(out[1]).slug).toBe('people/bob-sample');
  });

  test('--window-turns clamps: 0 and negatives behave as window 1', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    const out = await watchRun(
      [
        'assistant: Alice Example led one last year.',
        'user: what did she invest in?',
      ],
      ['--window-turns', '0', '--json'],
    );
    // Clamped to 1: fires on the mention turn only — identical to the
    // --window-turns 1 contract above, not a crash or an unbounded window.
    expect(out.length).toBe(1);
    expect(JSON.parse(out[0]).turn).toBe(1);
  });

  test('--window-turns absurdly large still runs (hard cap, no unbounded re-scan)', async () => {
    await seed('people/alice-example', 'Alice Example', 'Founder.');
    const filler = Array.from({ length: 70 }, (_, i) => `user: filler line ${i}`);
    const out = await watchRun(
      [...filler, 'user: ping Alice Example'],
      ['--window-turns', '999999', '--json'],
    );
    expect(out.length).toBe(1);
    expect(JSON.parse(out[0]).slug).toBe('people/alice-example');
  });
});

describe('gbrain watch — per-turn fail-open (review hardening)', () => {
  test('a transient DB error on one turn never kills the stream', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
    // Fail the FIRST resolver query against pages (turn 1's resolution);
    // everything else — incl. resolveSourceId's pre-loop check — passes.
    let pagesQueries = 0;
    const flaky = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') {
          return (sql: string, params: unknown[]) => {
            if (/FROM pages/.test(sql) && ++pagesQueries === 1) {
              return Promise.reject(new Error('transient db hiccup'));
            }
            return target.executeRaw(sql, params);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const out: string[] = [];
    await runWatch(flaky as never, ['--source', 'default'], {
      lines: feed(['user: ping Alice Example', 'user: ping Alice Example please']),
      write: (s) => out.push(s),
      isTTY: false,
    });
    // Turn 1 failed open; turn 2 volunteered. The stream survived.
    expect(out.join('')).toContain('people/alice-example');
  });
});
