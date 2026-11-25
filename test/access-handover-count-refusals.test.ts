/**
 * The handover preview's private-fact and bound-credential counts surface an engine refusal instead of showing zero,
 * and a handover's apply and undo refuse on an engine without raw SQL before they read or write anything.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: previewHandover counts the leaver's private facts and bound credentials through the typed members
 *    countMemberPageFacts and countMemberBoundCredentials; a count it could not read on a current schema is an error,
 *    never 0. Only a brain whose schema lacks the facts table or the member_id column (an older brain) reads 0.
 *    `gbrain access member handover --yes` and `--undo` on an engine without raw SQL refuse engine_capability_missing
 *    before any engine call, so nothing is half written.
 *  - Regression: both counts once caught every error and showed 0; an apply on the Rust engine reached its writes.
 *  - Why existing coverage misses it: the handover tests run on PGLite and Postgres, where every read succeeds.
 *  - Seam: a PGLite brain whose typed count member throws, and a recording engine that reports no raw_sql.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { addMember } from '../src/core/access/members.ts';
import { DEFAULT_CHOICES, previewHandover } from '../src/core/access/handover.ts';
import { handoverCmd } from '../src/commands/access-handover.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of ['owner-example', 'bob-example']) await addMember(engine, id);
  await engine.setConfig('access.owner_member', 'owner-example');
  await engine.setAccessMemberDisabled('bob-example', true);
});
afterAll(async () => { await engine.disconnect(); });

/** The brain with one typed member throwing `error()`. */
function throwing(member: 'countMemberPageFacts' | 'countMemberBoundCredentials', error: () => unknown): BrainEngine {
  return new Proxy(engine, {
    get(target, key, receiver) {
      if (key === member) return async () => { throw error(); };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

const memoryNote = (p: Awaited<ReturnType<typeof previewHandover>>) => p.groups.find(g => g.group === 'memory')!.note ?? '';
const refused = () => capabilityMissing('raw_sql', 'executeRaw');

describe('handover preview counts', () => {
  test('both counts read 0 when nothing is stored', async () => {
    const p = await previewHandover(engine, 'bob-example', DEFAULT_CHOICES);
    expect({ creds: p.bound_credentials, note: memoryNote(p) })
      .toEqual({ creds: 0, note: '0 private fact(s); never opened. The owner reads them on the brain host.' });
  });

  for (const member of ['countMemberPageFacts', 'countMemberBoundCredentials'] as const) {
    test(`a refused ${member} fails the preview instead of reading 0`, async () => {
      const err = await previewHandover(throwing(member, refused), 'bob-example', DEFAULT_CHOICES).then(() => null, (e: unknown) => e as { code?: string });
      expect(err?.code).toBe('engine_capability_missing');
    });
  }

  test('a schema without the facts table or the member_id column still reads 0', async () => {
    const missingTable = () => Object.assign(new Error('relation "facts" does not exist'), { code: '42P01', table_name: 'facts' });
    const missingColumn = () => Object.assign(new Error('column "member_id" does not exist'), { code: '42703', column_name: 'member_id' });
    const facts = await previewHandover(throwing('countMemberPageFacts', missingTable), 'bob-example', DEFAULT_CHOICES);
    const creds = await previewHandover(throwing('countMemberBoundCredentials', missingColumn), 'bob-example', DEFAULT_CHOICES);
    expect({ facts: memoryNote(facts).startsWith('0 private'), creds: creds.bound_credentials }).toEqual({ facts: true, creds: 0 });
  });
});

describe('handover apply and undo on an engine without raw SQL', () => {
  /** An engine that reports no raw_sql and records every member it is asked for. */
  function noRawSql(): { engine: BrainEngine; touched: string[] } {
    const touched: string[] = [];
    const caps = new Set(['pages', 'access_control', 'config']);
    const fake = new Proxy({}, {
      get(_t, key) {
        if (key === 'capabilities') return caps;
        if (key === 'kind') return 'rust';
        if (typeof key === 'string' && key !== 'then') touched.push(key);
        return undefined;
      },
    });
    return { engine: fake as BrainEngine, touched };
  }

  for (const [label, args] of [['--yes', ['bob-example', '--yes', '--expect', 'abc123']], ['--undo', ['bob-example', '--undo', 'h-1']], ['--undo with no member', ['--undo', 'h-1']]] as const) {
    test(`${label} refuses engine_capability_missing before any engine call`, async () => {
      const { engine: fake, touched } = noRawSql();
      const err = await handoverCmd(fake, [...args], true).then(() => null, (e: unknown) => e as { code?: string });
      expect({ code: err?.code, touched }).toEqual({ code: 'engine_capability_missing', touched: [] });
    });
  }
});
