/**
 * BrainEngine parity — the config reads that moved off executeRaw.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the DB-plane config merge (`applyDbPlaneReadSideMerge`) and the
 *    transcript-archive ledger read (`readArchiveLedger`) and the remote read
 *    policy (`readRemotePolicyNow`) return the same result on every engine
 *    arm, the Rust arm included.
 *  - Regression: an engine whose typed config reads drop a prefixed key,
 *    read a LIKE wildcard where the old statement matched a literal, or read a
 *    neighbouring source's ledger rows.
 *  - Why existing coverage misses it: test/config-db-merge.test.ts and the
 *    archive tests run on PGLite only; the per-member config cases never
 *    drive the merge or the ledger end to end.
 *  - Seam: none. Real engines through the parity harness.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { _resetDbPlaneMergeMemoForTests, applyDbPlaneReadSideMerge } from '../../src/core/config-db-merge.ts';
import { readArchiveLedger } from '../../src/core/transcripts/archive.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { readRemotePolicyNow } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: typed config reads', () => {
  parityTest(
    'the DB-plane merge reads scalar keys, cycle.* and provider_chat_options.* rows, literally',
    { methods: ['setConfig', 'getConfigValues', 'listConfigKeys'] },
    async (engine) => {
      _resetDbPlaneMergeMemoForTests();
      await engine.setConfig('chat_model', 'anthropic:claude-example');
      await engine.setConfig('expansion_model', '');
      await engine.setConfig('chat_fallback_chain', 'a:one,b:two');
      await engine.setConfig('chat_fallback_on_refusal', 'true');
      await engine.setConfig('cycle.alpha', '1');
      await engine.setConfig('cycle.beta', 'two');
      await engine.setConfig('cyclesX', 'decoy');
      await engine.setConfig('provider_chat_options.anthropic.temperature', '0.2');
      await engine.setConfig('providerXchatXoptions.anthropic.temperature', '9');
      const merged = {} as GBrainConfig;
      await applyDbPlaneReadSideMerge(merged, engine);
      _resetDbPlaneMergeMemoForTests();
      const m = merged as unknown as Record<string, unknown>;
      expect(m.chat_model).toBe('anthropic:claude-example');
      expect(m.expansion_model).toBeUndefined();
      expect(m.cycle).toEqual({ alpha: '1', beta: 'two' });
      return merged;
    },
  );

  parityTest(
    'readArchiveLedger reads only its own source, ordered by key',
    { methods: ['setConfig', 'listConfigKeys', 'getConfigValues'] },
    async (engine) => {
      const put = (key: string, value: unknown) => engine.setConfig(`transcripts.archive.ledger.${key}`, typeof value === 'string' ? value : JSON.stringify(value));
      await put('default.claude.hash2.2026-01-02', { status: 'written', page_slug: 'conversations/b' });
      await put('default.claude.hash1.2026-01-01', { status: 'written', page_slug: 'conversations/a' });
      await put('default.codex.hash3.2026-01-03', 'not json');
      await put('default.short', { status: 'written' });
      await put('default-2.claude.hash9.2026-01-09', { status: 'written' });
      const ledger = await readArchiveLedger(engine, 'default');
      expect(ledger.map((e) => e.conversation_key_hash)).toEqual(['hash1', 'hash2', 'hash3']);
      return { ledger, empty: await readArchiveLedger(engine, 'nothing-here') };
    },
  );

  parityTest(
    'readRemotePolicyNow reads the remote policy keys from the config table, not a fail-closed fallback',
    { methods: ['setConfig', 'getConfigValues'] },
    async (engine) => {
      const fresh = await readRemotePolicyNow(engine);
      expect(fresh.servesUnknown).toBeUndefined();
      await engine.setConfig('search.remote_private_pages', 'expose');
      await engine.setConfig('access.owner_member', 'owner-example');
      await engine.setConfig('access.serves', 'several');
      await engine.setConfig('access.serves_since', '2026-01-02T03:04:05.000Z');
      await engine.setConfig('access.requester_scope_enforce', 'false');
      await engine.setConfig('access.restrictions_present', '1');
      const set = await readRemotePolicyNow(engine);
      expect(set.restricted).toBe(true);
      expect(set.serves).toEqual({ several: true, from: 'config', since: 1767323045, enforce: false });
      // The keyed read the policy runs: the stored rows of the named keys, by key, a key with no row absent.
      const rows = await engine.getConfigValues(['access.serves', 'access.owner_member', 'no.such.key']);
      expect(rows).toEqual([{ key: 'access.owner_member', value: 'owner-example' }, { key: 'access.serves', value: 'several' }]);
      const { schemaVersion: _fv, ...freshRest } = fresh;
      const { schemaVersion: _sv, ...setRest } = set;
      return { fresh: freshRest, set: setRest };
    },
  );
});
