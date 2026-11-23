/**
 * BrainEngine parity: the configured-owner read of the labelled-only create check (persistence/page-visibility.ts
 * writerLabelledOnly and assertLabelledOnlyCreate), on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the check reads the configured owner (config access.owner_member) through the typed getConfig member,
 *    never as a raw statement. The owner's own create is never held to the labelled-only rule, and a labelled-only
 *    member's refusal names the owner in the page rule it prints. An owner read that fails still refuses, naming the
 *    member alone.
 *  - Regression: both owner reads were the raw `SELECT value FROM config WHERE key = $1`. The Rust engine refuses raw
 *    SQL, so on a Rust brain with a labelled-only member every remote create stopped on raw_sql, the owner's included.
 *  - Why existing coverage misses it: test/access-labelled-only.test.ts and test/access-rule-hints-owner-gst2128.test.ts
 *    run on PGLite and Postgres only, where the raw statement works.
 *  - Seam: the Rust store cannot mark a member labelled-only yet, so the first case answers hasLabelledOnlyMember true
 *    on every arm (a brain that holds a labelled-only member). Each case counts the raw config statements it sends;
 *    the engines and every other read are real.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { addMember } from '../../src/core/access/members.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { assertLabelledOnlyCreate } from '../../src/core/persistence/page-visibility.ts';
import type { WriteAuthority } from '../../src/core/persistence/model.ts';
import { OWNER_MEMBER_KEY } from '../../src/core/search/private-visibility.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const OWNER = 'owner-example';
const BOT = 'bot-example';
const CONFIG_READ = 'SELECT value FROM config WHERE key = $1';

/** A remote write by a local stdio serve bound to `member` (its identity is read live through readLiveMember). */
const authorityFor = (member: string) => ({ version: 1, principal: { kind: 'local_stdio', id: 'parity-stdio' }, stdioMember: member,
  remote: true, excludePrivate: true, sourceId: 'default', sourceIncarnation: 'unused', scopes: ['read', 'write'], operations: null,
  slugPrefixes: null }) as unknown as WriteAuthority;

/** `engine` with the raw config statements it sends counted, and the given members answered instead. */
function counted(engine: BrainEngine, answers: Partial<Record<keyof BrainEngine, unknown>> = {}): { view: BrainEngine; rawConfigReads: () => number } {
  let reads = 0;
  const view = new Proxy(engine, { get(target, key) {
    if (Object.hasOwn(answers, key)) return answers[key as keyof BrainEngine];
    const value = Reflect.get(target, key, target);
    if (key === 'executeRaw') return (sql: string, ...rest: unknown[]) => { if (sql.trim() === CONFIG_READ) reads++; return (value as Function).call(target, sql, ...rest); };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { view, rawConfigReads: () => reads };
}

/** The create check's outcome as a caller sees it: allowed, or the refusal's code and the readers its page rule lists. */
async function outcome(run: Promise<void>): Promise<unknown> {
  try {
    await run;
    return 'allowed';
  } catch (error) {
    const e = error as { code?: string; fix?: { argv?: string[] } };
    // A typed refusal is the engine's, not the check's: let the harness count it (the Rust store still refuses the raw
    // folder-rule read of page-visibility.ts and labelledOnlyFor's raw read, a known gap).
    if (e.code === 'engine_capability_missing') throw error;
    const argv = e.fix?.argv ?? [];
    return { refused: e.code ?? String(error), readers: argv.includes('--readers') ? argv[argv.indexOf('--readers') + 1] : null };
  }
}

describe('engine parity: the owner read of the labelled-only create check', () => {
  parityTest('the owner creating an unlabelled page on a brain with a labelled-only member is allowed, reading the owner through getConfig',
    { methods: ['insertAccessMember', 'setConfig', 'getConfig', 'readLiveMember'], timeout: 120_000 },
    async (engine: BrainEngine) => {
      await addMember(engine, OWNER, { name: 'Owner' });
      await engine.setConfig(OWNER_MEMBER_KEY, OWNER);
      const { view, rawConfigReads } = counted(engine, { hasLabelledOnlyMember: async () => true });
      const out = { create: await outcome(assertLabelledOnlyCreate(view, authorityFor(OWNER), 'notes/owner-new', null, {})), rawConfigReads: rawConfigReads() };
      expect(out).toEqual({ create: 'allowed', rawConfigReads: 0 });
      return out;
    });

  parityTest('a labelled-only member creating an unlabelled page is refused with a page rule that names the owner, or the member alone when the owner read fails',
    { methods: ['executeRaw', 'insertAccessMember', 'setConfig', 'getConfig', 'readLiveMember'], requires: 'raw_sql', timeout: 120_000 },
    async (engine: BrainEngine) => {
      await addMember(engine, OWNER, { name: 'Owner' });
      await addMember(engine, BOT, { name: 'Bot' });
      await engine.setConfig(OWNER_MEMBER_KEY, OWNER);
      await setMemberLabelledOnly(engine, BOT, true, { remote: false });
      const plain = counted(engine);
      const named = { create: await outcome(assertLabelledOnlyCreate(plain.view, authorityFor(BOT), 'notes/bot-new', null, {})), rawConfigReads: plain.rawConfigReads() };
      // The second owner read (the printed page rule) fails: the refusal still comes, naming the member alone.
      let ownerReads = 0;
      const failing = counted(engine, { getConfig: async (key: string) => {
        if (key === OWNER_MEMBER_KEY && ++ownerReads > 1) throw Object.assign(new Error('injected owner read failure'), { code: '08006' });
        return engine.getConfig(key);
      } });
      const unread = { create: await outcome(assertLabelledOnlyCreate(failing.view, authorityFor(BOT), 'notes/bot-new', null, {})), rawConfigReads: failing.rawConfigReads() };
      const out = { named, unread };
      expect(out).toEqual({
        named: { create: { refused: 'access_labelled_only_unnamed', readers: `${BOT},${OWNER}` }, rawConfigReads: 0 },
        unread: { create: { refused: 'access_labelled_only_unnamed', readers: BOT }, rawConfigReads: 0 },
      });
      return out;
    });
});
