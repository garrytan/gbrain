/**
 * `recall` composes `entity`, `session_id` and `since` into ONE engine query.
 *
 * The op used to branch `entity` > `session_id` > `since` as an if / else-if
 * chain: with `entity` set the `since` window was never applied (the entity
 * arm called listFactsByEntity without a cutoff), and `session_id` + `since`
 * had the same shape. A caller asking for "facts about X since T" silently
 * got every fact about X. An unparseable `since` was swallowed the same way
 * (an empty or unfiltered result instead of an error).
 *
 * Pinned here, through the real op via dispatchToolCall and through the CLI's
 * local fetch path:
 *  - entity + since excludes facts older than the cutoff
 *  - session_id + since likewise, and entity + session_id + since AND together
 *  - the window is EVENT time (COALESCE(valid_from, created_at)), same as the
 *    since-only arm, so a backdated row drops out even though it was written now
 *  - the boundary is inclusive at the cutoff
 *  - the cutoff lands before the SQL LIMIT: a limit never refills with rows
 *    from outside the window
 *  - an unparseable since is rejected with invalid_params
 *  - the CLI's entity-TEXT fallback (a bare positional that resolves to no
 *    entity is retried as a fact-text grep, #4720) keeps the window: an
 *    explicit `--since` on event time, `--since-last-run` on the cursor's
 *    creation-time watermark. Without it a windowed recall for an unknown
 *    term returned the term's whole history.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runRecall } from '../src/commands/recall.ts';
import { writeCursor } from '../src/core/recall-cursor-state.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

let engine: PGLiteEngine;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
// Fixed cutoff for the boundary test (well inside every "48 hours ago" window).
const CUTOFF = new Date(NOW - 2 * HOUR);
// GBRAIN_HOME for the --since-last-run case (the cursor file lives under it).
const cursorHome = emptyHome();

async function seed(fact: string, opts: { entity?: string; session?: string; validFrom: Date }): Promise<void> {
  await engine.insertFact(
    {
      fact,
      kind: 'fact',
      entity_slug: opts.entity,
      source: 'test',
      source_session: opts.session,
      valid_from: opts.validFrom,
      visibility: 'world',
    },
    { source_id: 'default' },
  );
}

async function recallFacts(params: Record<string, unknown>): Promise<string[]> {
  const result = await dispatchToolCall(engine, 'recall', params, { remote: false, sourceId: 'default' });
  expect(result.isError).toBeFalsy();
  const payload = JSON.parse(result.content[0].text);
  return (payload.facts as { fact: string }[]).map((f) => f.fact);
}

async function recallCli(args: string[], home = emptyHome()): Promise<string[]> {
  const origWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await runRecall(engine, [...args, '--json']);
    });
  } finally {
    process.stdout.write = origWrite;
  }
  const payload = JSON.parse(captured.trim());
  return (payload.facts as { fact: string }[]).map((f) => f.fact);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Every row is CREATED now; only valid_from (event time) differs, so a
  // creation-time window would keep all of them.
  await seed('window-entity-recent', { entity: 'ent-window', validFrom: new Date(NOW - HOUR) });
  await seed('window-entity-old', { entity: 'ent-window', validFrom: new Date(NOW - 30 * DAY) });

  await seed('window-session-recent', { session: 'sess-window', validFrom: new Date(NOW - HOUR) });
  await seed('window-session-old', { session: 'sess-window', validFrom: new Date(NOW - 30 * DAY) });

  await seed('triple-match', { entity: 'ent-triple', session: 'sess-a', validFrom: new Date(NOW - HOUR) });
  await seed('triple-other-session', { entity: 'ent-triple', session: 'sess-b', validFrom: new Date(NOW - HOUR) });
  await seed('triple-old', { entity: 'ent-triple', session: 'sess-a', validFrom: new Date(NOW - 30 * DAY) });

  await seed('boundary-at-cutoff', { entity: 'ent-boundary', validFrom: CUTOFF });
  await seed('boundary-before-cutoff', { entity: 'ent-boundary', validFrom: new Date(CUTOFF.getTime() - 1000) });

  await seed('page-in-window', { entity: 'ent-page', validFrom: new Date(NOW - HOUR) });
  await seed('page-old-1', { entity: 'ent-page', validFrom: new Date(NOW - 10 * DAY) });
  await seed('page-old-2', { entity: 'ent-page', validFrom: new Date(NOW - 20 * DAY) });
  await seed('page-old-3', { entity: 'ent-page', validFrom: new Date(NOW - 30 * DAY) });

  // Entity-text fallback rows: no entity, the query term only appears in the
  // TEXT. Same event-time split as above; the old row's created_at is also
  // backdated so the creation-time (--since-last-run) window excludes it.
  await seed('textfb-zebrule recent', { validFrom: new Date(NOW - HOUR) });
  await seed('textfb-zebrule old', { validFrom: new Date(NOW - 10 * DAY) });
  await engine.executeRaw(
    `UPDATE facts SET created_at = now() - interval '10 days' WHERE fact = 'textfb-zebrule old'`,
  );
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(cursorHome, { recursive: true, force: true });
});

describe('recall op: entity / session_id / since compose before the SQL LIMIT', () => {
  test('entity + since excludes facts whose event time is older than the cutoff', async () => {
    const facts = await recallFacts({ entity: 'ent-window', since: '48 hours ago' });
    expect(facts).toContain('window-entity-recent');
    expect(facts).not.toContain('window-entity-old');
  });

  test('entity without since keeps the full entity card', async () => {
    const facts = await recallFacts({ entity: 'ent-window' });
    expect(facts).toContain('window-entity-recent');
    expect(facts).toContain('window-entity-old');
  });

  test('session_id + since excludes facts whose event time is older than the cutoff', async () => {
    const facts = await recallFacts({ session_id: 'sess-window', since: '48 hours ago' });
    expect(facts).toContain('window-session-recent');
    expect(facts).not.toContain('window-session-old');
  });

  test('entity + session_id + since AND together', async () => {
    const facts = await recallFacts({ entity: 'ent-triple', session_id: 'sess-a', since: '48 hours ago' });
    expect(facts).toEqual(['triple-match']);
  });

  test('boundary: a fact whose event time equals the cutoff is included, one second earlier is not', async () => {
    const facts = await recallFacts({ entity: 'ent-boundary', since: CUTOFF.toISOString() });
    expect(facts).toContain('boundary-at-cutoff');
    expect(facts).not.toContain('boundary-before-cutoff');
  });

  test('limit never refills from outside the window (cutoff lands before LIMIT)', async () => {
    const facts = await recallFacts({ entity: 'ent-page', since: '48 hours ago', limit: 2 });
    expect(facts).toEqual(['page-in-window']);
    // Without the window the same limit returns the two newest by event time.
    const unbounded = await recallFacts({ entity: 'ent-page', limit: 2 });
    expect(unbounded).toEqual(['page-in-window', 'page-old-1']);
  });

  test('an unparseable since is rejected with invalid_params instead of widening the window', async () => {
    for (const params of [
      { entity: 'ent-window', since: 'sometime last week' },
      { session_id: 'sess-window', since: 'sometime last week' },
      { since: 'sometime last week' },
    ]) {
      const result = await dispatchToolCall(engine, 'recall', params, { remote: false, sourceId: 'default' });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.error).toBe('invalid_params');
      expect(String(err.message)).toContain('since');
    }
  });
});

describe('engine: listFactsSince composes sessionId in SQL', () => {
  test('sessionId ANDs onto the event-time window', async () => {
    const rows = await engine.listFactsSince('default', new Date(NOW - 2 * DAY), {
      eventTime: true,
      sessionId: 'sess-a',
    });
    expect(rows.map((r) => r.fact)).toEqual(['triple-match']);
  });
});

describe('gbrain recall CLI (local path) composes the same way', () => {
  test('<entity> --since excludes older facts', async () => {
    const facts = await recallCli(['ent-window', '--since', '48 hours ago']);
    expect(facts).toContain('window-entity-recent');
    expect(facts).not.toContain('window-entity-old');
  });

  test('--session-id --since excludes older facts', async () => {
    const facts = await recallCli(['--session-id', 'sess-window', '--since', '48 hours ago']);
    expect(facts).toContain('window-session-recent');
    expect(facts).not.toContain('window-session-old');
  });
});

describe('gbrain recall CLI entity-text fallback honors the window', () => {
  test('unknown positional + --since matches by text but only inside the event-time window', async () => {
    // Sanity: without a window the fallback returns the term's full history.
    expect((await recallCli(['zebrule'])).sort()).toEqual(['textfb-zebrule old', 'textfb-zebrule recent']);
    expect(await recallCli(['zebrule', '--since', '48 hours ago'])).toEqual(['textfb-zebrule recent']);
  });

  test('unknown positional + --since-last-run keeps the cursor watermark (creation time)', async () => {
    await withEnv({ GBRAIN_HOME: cursorHome }, () => writeCursor('default', new Date(NOW - 2 * DAY)));
    expect(await recallCli(['zebrule', '--since-last-run'], cursorHome)).toEqual(['textfb-zebrule recent']);
  });
});
