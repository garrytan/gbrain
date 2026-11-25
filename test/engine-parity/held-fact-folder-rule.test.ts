/**
 * BrainEngine parity: a held fact (one kept on a holding page, `<folder>/memory/unattributed`) whose entity sits under a
 * folder rule, read by a remote member who satisfies the rule and by one who does not (sharedHeldRuledSql in
 * src/core/search/private-visibility.ts; `hidden_by_private_provenance` in rust/crates/gbrain-store/src/facts/privacy.rs).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a member whose rule covers the entity reads its held fact; a caller with no satisfied rule never does.
 *  - Regression: the Rust store hid every held fact under any folder rule, the satisfied ones included, so a member read
 *    fewer facts on a Rust brain than on PGLite.
 *  - Why existing coverage misses it: test/engine-parity/remote-access-matrix.test.ts has no held fact.
 *  - Seam: the caller record is built as remote dispatch builds it (remoteCallerAccess with a verified token), and the
 *    fact list read is called under it directly, so no other remote-read side effect (the access read log) runs.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { parityTest } = parityArms(testBackends());

const ENTITY = 'partners/bob-example/plan';
const HOLDING = 'partners/bob-example/memory/unattributed';
const HELD = 'Harbor ledger held note cnryheldfactzz';

async function seed(engine: BrainEngine): Promise<Record<'bob' | 'carol', string>> {
  __resetPrivateVisibilityCacheForTests();
  for (const id of ['bob-example', 'carol-example']) await addMember(engine, id, { remote: false });
  await proposeRevision(engine, 'default', [{ id: 'bob-folder', prefix: 'partners/bob-example/', readable_by: ['member:bob-example'] }], { origin: 'cli', store: 'database' });
  await importFromContent(engine, ENTITY, `---\ntitle: Plan\ntype: note\n---\nPlan body.\n`, { sourceId: 'default', noEmbed: true } as never);
  await engine.insertFacts([{ fact: HELD, entity_slug: ENTITY, source: 'fixture', visibility: 'world', row_num: 1, source_markdown_slug: HOLDING }], { source_id: 'default' });
  const mint = async (name: string, member: string) => {
    const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
    await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
    return minted.token;
  };
  return { bob: await mint('bob', 'bob-example'), carol: await mint('carol', 'carol-example') };
}

async function factsAs(engine: BrainEngine, token: string): Promise<string[]> {
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine });
  const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
  const access = await remoteCallerAccess(engine, auth, [], 'http');
  const rows = await withCallerAccess(access, () => engine.listFactsByEntity('default', ENTITY, { excludePrivate: true, activeOnly: false }));
  return rows.map(r => r.fact).sort();
}

describe('engine parity: a held fact under a folder rule', () => {
  parityTest('a member who satisfies the rule reads the held fact; one who does not, never', {
    methods: ['listFactsByEntity', 'insertFacts'],
  }, async (engine) => {
    const tokens = await seed(engine);
    const got = { bob: await factsAs(engine, tokens.bob), carol: await factsAs(engine, tokens.carol) };
    expect(got).toEqual({ bob: [HELD], carol: [] });
    return got;
  });
});
