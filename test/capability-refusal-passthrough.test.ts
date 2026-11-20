/**
 * A brain whose engine refuses a call (`engine_capability_missing`, the Rust
 * engine before it serves a capability) must refuse the command, never print an
 * empty or partial answer. Each fail-soft read below rethrows the refusal and
 * keeps its old behavior for every other error, so PGLite and Postgres answer as
 * before. Synthetic names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { seedPage } from './helpers/keyword-paging-fixture.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { findExperts, runWhoknows } from '../src/commands/whoknows.ts';
import type { Capability } from '../src/core/engine-capabilities.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await seedPage(engine, 'people/alice-example', 'Alice Example works on keyword ranking.', { type: 'person', title: 'Alice Example' });
});

/** The PGLite engine with `member` replaced by a thrower: a capability refusal, or a plain failure for the control. */
function failing(member: keyof BrainEngine, capability: Capability, kind: 'refusal' | 'plain'): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === member) {
        return async () => {
          throw kind === 'refusal' ? capabilityMissing(capability, String(member)) : new Error(`${String(member)} failed`);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

/** The refusal's code survives, so `--json` output carries it. */
const isCapabilityMissing = (e: unknown) => (e as { code?: unknown } | null)?.code === 'engine_capability_missing';

async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a capability refusal, got an answer');
}

describe('entity', () => {
  test('a refused text-mention probe refuses a miss instead of printing unread: read_failed', async () => {
    const e = await refusalOf(buildEntityCard(failing('searchKeyword', 'keyword_search', 'refusal'), 'default', 'Imogen Nobody', { remote: false, includeReferences: true }));
    expect(isCapabilityMissing(e)).toBe(true);
  });
});

describe('whoknows', () => {
  test('a refused pack read refuses the command instead of printing []', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const e = await refusalOf(runWhoknows(failing('getConfig', 'config', 'refusal'), ['keyword', '--json']));
      expect(isCapabilityMissing(e)).toBe(true);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test('a refused salience read refuses the ranking', async () => {
    const e = await refusalOf(findExperts(failing('getSalienceScores', 'pages', 'refusal'), { topic: 'keyword ranking', types: ['person'] }));
    expect(isCapabilityMissing(e)).toBe(true);
  });

  test('any other salience failure still ranks without it', async () => {
    const rows = await findExperts(failing('getSalienceScores', 'pages', 'plain'), { topic: 'keyword ranking', types: ['person'] });
    expect(rows.map(r => r.slug)).toContain('people/alice-example');
  });
});

