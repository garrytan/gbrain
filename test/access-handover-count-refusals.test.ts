/**
 * The handover preview's private-fact and bound-credential counts surface an engine refusal instead of showing zero.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: previewHandover counts the leaver's private facts and bound credentials; a count it could not read on a
 *    current schema is an error, never 0. Only a brain whose schema lacks the facts table or the member_id columns
 *    (an older brain) reads 0.
 *  - Regression: both counts once caught every error and showed 0, so an engine that refused the read (a Rust brain
 *    refuses raw SQL with engine_capability_missing) printed "0 private fact(s)" and "bound_credentials: 0".
 *  - Why existing coverage misses it: the handover tests run on PGLite and Postgres, where both reads succeed.
 *  - Seam: a PGLite brain whose executeRaw refuses exactly one of the two count statements.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { addMember } from '../src/core/access/members.ts';
import { DEFAULT_CHOICES, previewHandover } from '../src/core/access/handover.ts';
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

/** The brain with executeRaw refusing (or failing) the one statement whose text contains `needle`. */
function refusing(needle: string, error: () => unknown): BrainEngine {
  return new Proxy(engine, {
    get(target, key, receiver) {
      if (key !== 'executeRaw') return Reflect.get(target, key, receiver);
      return (sql: string, params?: unknown[]) => sql.includes(needle) ? Promise.reject(error()) : target.executeRaw(sql, params);
    },
  }) as unknown as BrainEngine;
}

const FACTS = 'FROM facts f JOIN pages p';
const CREDS = 'FROM access_tokens WHERE member_id';

describe('handover preview counts', () => {
  test('both counts read 0 when nothing is stored', async () => {
    const p = await previewHandover(engine, 'bob-example', DEFAULT_CHOICES);
    expect({ creds: p.bound_credentials, note: p.groups.find(g => g.group === 'memory')!.note })
      .toEqual({ creds: 0, note: '0 private fact(s); never opened. The owner reads them on the brain host.' });
  });

  for (const [name, needle] of [['private-fact', FACTS], ['bound-credential', CREDS]] as const) {
    test(`a refused ${name} count fails the preview instead of reading 0`, async () => {
      const err = await previewHandover(refusing(needle, () => capabilityMissing('raw_sql', 'executeRaw')), 'bob-example', DEFAULT_CHOICES)
        .then(() => null, (e: unknown) => e as { code?: string });
      expect(err?.code).toBe('engine_capability_missing');
    });
  }

  // The private-fact count once joined on a column the facts table does not have, so it always failed and read 0.
  test('the counts name the facts on the member page and the credentials bound to the member', async () => {
    await engine.putPage('memory/members/bob-example', { type: 'note', title: 'bob', compiled_truth: 'notes', timeline: '', frontmatter: { readable_by: ['member:bob-example'] } });
    await engine.insertFacts([1, 2].map(row_num => ({ fact: `bob fact ${row_num}`, kind: 'fact', visibility: 'private', notability: 'medium', source: 'test',
      entity_slug: 'people/bob-example', row_num, source_markdown_slug: 'memory/members/bob-example' })) as never, { source_id: 'default' });
    await engine.insertAccessToken({ name: 'bob-key', token_hash: 'hash-bob', scopes: ['read'], permissions: {}, source_grant: 'default', source_id: null,
      federated_read: null, allowed_operations: null, takes_holders: null, member_id: 'bob-example' });
    const p = await previewHandover(engine, 'bob-example', DEFAULT_CHOICES);
    expect({ creds: p.bound_credentials, note: p.groups.find(g => g.group === 'memory')!.note })
      .toEqual({ creds: 1, note: '2 private fact(s); never opened. The owner reads them on the brain host.' });
  });

  test('a schema without the facts table or the member_id column still reads 0', async () => {
    const missingTable = () => Object.assign(new Error('relation "facts" does not exist'), { code: '42P01', table_name: 'facts' });
    const missingColumn = () => Object.assign(new Error('column "member_id" does not exist'), { code: '42703', column_name: 'member_id' });
    const facts = await previewHandover(refusing(FACTS, missingTable), 'bob-example', DEFAULT_CHOICES);
    const creds = await previewHandover(refusing(CREDS, missingColumn), 'bob-example', DEFAULT_CHOICES);
    expect({ facts: facts.groups.find(g => g.group === 'memory')!.note!.startsWith('0 private'), creds: creds.bound_credentials })
      .toEqual({ facts: true, creds: 0 });
  });
});
