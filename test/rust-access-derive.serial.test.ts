/**
 * Multi-user lane L4: the store's own privacy derivation (rust/crates/gbrain-store/src/access_derive.rs) against the
 * TypeScript policy helpers it ports (store-members/private-provenance.ts, page-visibility.ts, fact-visibility.ts,
 * remote-floor.ts), over a generated corpus of caller records, settings and requests. Every outcome must be equal:
 * the policy value, `undefined` (no policy asked for) and the refusal. Then the self-check itself: a store answer
 * that differs, a missing derivation and a mislabelled fragment each refuse before the store is called.
 *
 * Needs the addon `bun run rust:build` writes (or GBRAIN_TEST_RUST_ENGINE_ADDON).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { accessDeriveContext, firstDifference, withAccessStore, type AccessDeriveRequest } from '../src/core/rust-engine/access-self-check.ts';
import {
  storeFloorPolicy, storeMemberReadPolicy, storePageTextPolicy, storePrivacyPolicy,
} from '../src/core/rust-engine/store-members/private-provenance.ts';
import { storeRemoteFloor } from '../src/core/rust-engine/store-members/remote-floor.ts';
import { storeVisibility } from '../src/core/rust-engine/store-members/fact-visibility.ts';
import { readPageHiddenFromCaller, readPagePrivacyHidden } from '../src/core/rust-engine/store-members/page-visibility.ts';
import {
  __resetPrivateVisibilityCacheForTests, privateFactFilterForCaller, privateFactFilterForReader, privatePagesFilterForCaller,
  privatePagesFilterFragment, privateProvenanceFilterUnderPolicy, readHonorAliases, callerAccessRecord, remoteReadFloorSql, withCallerAccess,
  type CallerAccess,
} from '../src/core/search/private-visibility.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { rustArmAddonPath } from './engine-parity/rust-arm.ts';
import { plainPageFlags } from '../src/core/rust-engine/store-members/private-provenance.ts';
import { openPageFloorPolicy } from '../src/core/rust-engine/store-members/access-setup.ts';
import { writerPolicy } from '../src/core/rust-engine/store-members/remote-links.ts';
import { snapshotServed } from '../src/core/rust-engine/store-members/trust-tier-reads.ts';
import { retirementHopPolicy } from '../src/core/rust-engine/store-members/cli-entities.ts';
import { memberAccessPolicy } from '../src/core/rust-engine/store-members/list-reads.ts';
import { rowOwnerOnly } from '../src/core/rust-engine/store-members/write-attribution.ts';

const ADDON = rustArmAddonPath();
let derive: (ctx: unknown) => unknown;
const SWITCHES = ['GBRAIN_RUST_MULTIUSER', 'GBRAIN_RUST_ACCESS_SELF_CHECK', 'GBRAIN_REMOTE_PRIVATE_PAGES'] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  if (!existsSync(ADDON)) throw new Error(`${ADDON} does not exist; run bun run rust:build`);
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON } });
  derive = addon.deriveAccessPolicy as (ctx: unknown) => unknown;
  if (typeof derive !== 'function') throw new Error('the addon has no deriveAccessPolicy export');
  for (const k of SWITCHES) { saved[k] = process.env[k]; delete process.env[k]; }
});

afterAll(() => {
  for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  __resetPrivateVisibilityCacheForTests();
});

/** A small seeded generator, so a failing record can be reproduced by its index. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const AXES = {
  identity: [undefined, [], ['member:alice-example'], ['group:team-a', 'member:alice-example'], ['member:bob-example'], ['Member:Bad'], ['member:alice-example', 'member:bob-example']],
  audience: [undefined, null, ['member:alice-example'], ['member:alice-example', 'member:bob-example'], ['guest'], ['Bad Entry']],
  audienceIdentities: [undefined, [['member:alice-example']], [['member:alice-example'], ['member:bob-example']]],
  actor: [undefined, null, { system: 'chat', external_id: 'u1', member: 'alice-example' }],
  satisfiedRuleIds: [undefined, [], ['wiki:team'], ['wiki:team', 'wiki:ops'], ['bad id']],
  folderCoverage: [undefined, [], [{ source_id: 'wiki', prefix: 'secret/' }], [{ source_id: 'wiki', prefix: '' }], [{ source_id: 'BAD', prefix: 'x/' }]],
  privateReadableSources: [undefined, [], ['wiki'], ['wiki', 'notes'], ['BAD']],
  privateFactSources: [undefined, [], ['wiki']],
  hidePrivate: [undefined, true, false],
  owner: [undefined, false, true],
  ownerReads: [undefined, true],
  lineage: [undefined, true],
  ownerReadsRestricted: [undefined, true],
  audienceKindMembers: [undefined, ['room-a']],
  labelledOnly: [undefined, true],
  restricted: [undefined, true, false],
  remotePolicy: [undefined, { privacyRelaxed: false, restricted: true }, ...[300, 311, 320, 328, 340].map(v => ({ privacyRelaxed: false, restricted: true, schemaVersion: v }))],
} as const;

/** A record patch drawn from the axes; `undefined` axes are left out, as a caller that never set them. */
function drawPatch(r: () => number): Partial<CallerAccess> {
  const patch: Record<string, unknown> = {};
  for (const [k, values] of Object.entries(AXES)) {
    const v = pick(r, values as readonly unknown[]);
    if (v !== undefined) patch[k] = v;
  }
  return patch as Partial<CallerAccess>;
}

/** Named records the random draw may miss. */
const EDGE_PATCHES: Array<Partial<CallerAccess> | null> = [
  null,
  {},
  { identity: [] },
  { identity: ['member:alice-example'], restricted: false },
  { identity: ['member:alice-example'], owner: true, hidePrivate: false },
  { identity: ['member:alice-example'], owner: true, ownerReads: true, hidePrivate: false, remotePolicy: { privacyRelaxed: false, restricted: true, schemaVersion: 330 } },
  { identity: ['member:alice-example'], owner: true, lineage: true, audienceKindMembers: ['room-a'], ownerReadsRestricted: true },
  { identity: ['member:alice-example'], lineage: true },
  { identity: ['member:alice-example'], labelledOnly: true },
  { identity: ['member:alice-example'], labelledOnly: true, lineage: true },
  // The labelled-only lineage branch on an owner read (labelledOnlySql skips it) and on a member read without one.
  { identity: ['member:alice-example'], labelledOnly: true, lineage: true, owner: true },
  { identity: ['member:alice-example'], labelledOnly: true, lineage: true, owner: true, hidePrivate: false, remotePolicy: { privacyRelaxed: false, restricted: true, schemaVersion: 330 } },
  { identity: [], labelledOnly: true, lineage: true, owner: true },
  { identity: ['group:team-a'], labelledOnly: true, lineage: true, owner: true, satisfiedRuleIds: ['wiki:team'] },
  { identity: ['member:alice-example'], privateFactSources: ['wiki'] },
  { identity: ['member:alice-example'], privateReadableSources: ['wiki'], satisfiedRuleIds: ['wiki:team'], folderCoverage: [{ source_id: 'wiki', prefix: 'p/' }] },
  { identity: [], audience: ['member:alice-example', 'member:bob-example'], audienceIdentities: [['member:alice-example'], ['member:bob-example']] },
  { restricted: false },
  { restricted: false, identity: ['member:alice-example'], privateFactSources: ['wiki'] },
  { hidePrivate: false },
  { actor: { system: 'chat', external_id: 'u1', member: 'alice-example' }, identity: ['member:alice-example'] },
];

const VISIBILITY_LISTS: Array<string[] | undefined> = [undefined, [], ['world'], ['private'], ['world', 'private'], ['other']];
const MEMBER_READS = [
  { owner: false, identity: [], satisfied: [] },
  { owner: false, identity: ['member:carol-example'], satisfied: [] },
  { owner: false, identity: ['group:x', 'member:carol-example'], satisfied: [] },
  { owner: false, identity: ['member:carol-example'], satisfied: ['wiki:team'] },
  { owner: false, identity: ['NotValid'], satisfied: [] },
  { owner: true, identity: ['member:carol-example'], satisfied: [] },
  { owner: true, identity: ['group:x'], satisfied: [] },
  { owner: true, identity: [], satisfied: [] },
];

const WRITERS = [
  { identities: [], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false },
  { identities: [], satisfiedRuleIds: [], folderCoverage: [{ source_id: 'wiki', prefix: 'secret/' }], owner: false, labelledOnly: false },
  { identities: [['member:alice-example']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false },
  { identities: [['group:team-a', 'member:alice-example']], satisfiedRuleIds: [], folderCoverage: [], owner: true, labelledOnly: false },
  { identities: [['member:alice-example']], satisfiedRuleIds: ['wiki:team'], folderCoverage: [], owner: false, labelledOnly: false },
  { identities: [['member:alice-example']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: true },
  { identities: [['member:alice-example'], ['member:bob-example']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false },
  { identities: [['Bad Id']], satisfiedRuleIds: [], folderCoverage: [{ source_id: 'BAD', prefix: 'x/' }], owner: false, labelledOnly: false },
];
const SNAPSHOT_READERS = [
  { identity: [], privateReadableSources: [] },
  { identity: ['member:alice-example'], privateReadableSources: [] },
  { identity: ['group:team-a', 'member:alice-example'], privateReadableSources: ['wiki'] },
  { identity: ['member:bob-example'], privateReadableSources: [] },
];

const PAGE_THUNKS = {
  caller: () => privatePagesFilterForCaller('p'),
  floor: () => remoteReadFloorSql('p'),
  plain: () => privatePagesFilterFragment('p'),
} as const;
const FACT_THUNKS = {
  under_policy: () => privateProvenanceFilterUnderPolicy('facts'),
  for_caller: () => privateFactFilterForCaller('facts'),
  for_reader: () => privateFactFilterForReader('facts'),
} as const;

/** A fake store that records the policy a member sends and answers nothing. */
function recordingBrain(): { brain: Record<string, (...a: unknown[]) => Promise<unknown>>; sent: unknown[] } {
  const sent: unknown[] = [];
  const brain = {
    readPageHiddenFromCaller: async (_s: unknown, _x: unknown, policy: unknown) => { sent.push(policy); return false; },
    readPagePrivacyHidden: async (_s: unknown, _x: unknown, honor: unknown) => { sent.push(honor); return null; },
  };
  return { brain, sent };
}

interface Case { request: AccessDeriveRequest; run: () => unknown | Promise<unknown> }

function cases(): Case[] {
  const out: Case[] = [];
  for (const fragment of ['caller', 'floor', 'plain'] as const) {
    for (const opts of [{}, { callerReaders: true }, { noReaders: true }]) {
      out.push({ request: { mode: 'page_text', fragment, ...opts }, run: () => storePageTextPolicy('m', PAGE_THUNKS[fragment], { ...opts, fragment }) });
    }
  }
  // A fragment rendered in the caller's record, judged inside the empty-identity record (countOpenPages).
  out.push({ request: { mode: 'page_text', fragment: 'plain', callerReaders: true, renderedIn: { record: null } },
    run: () => { throw new Error('replaced per record'); } });
  for (const fragment of ['under_policy', 'for_caller', 'for_reader'] as const) {
    for (const callerReaders of [false, true]) {
      for (const excludePrivate of [true, false]) {
        out.push({ request: { mode: 'fact', excludePrivate, fragment, callerReaders },
          run: () => storePrivacyPolicy('m', excludePrivate, FACT_THUNKS[fragment], { callerReaders, fragment }) });
      }
    }
  }
  out.push({ request: { mode: 'floor_policy' }, run: () => storeFloorPolicy('m') });
  out.push({ request: { mode: 'remote_floor' }, run: () => storeRemoteFloor('m') });
  for (const q of MEMBER_READS) out.push({ request: { mode: 'member_read', ...q }, run: () => storeMemberReadPolicy('m', q) });
  for (const list of VISIBILITY_LISTS) {
    out.push({ request: { mode: 'visibility', ...(list ? { list } : {}) }, run: () => storeVisibility('m', list) });
  }
  out.push({ request: { mode: 'plain_page_flags' }, run: () => plainPageFlags('m') });
  out.push({ request: { mode: 'open_page_floor' }, run: () => openPageFloorPolicy() });
  out.push({ request: { mode: 'access_part_plain' }, run: () => retirementHopPolicy('member_access', 'm') });
  out.push({ request: { mode: 'row_owner_only' }, run: () => rowOwnerOnly(true, 'takes') });
  out.push({ request: { mode: 'row_owner_only' }, run: () => rowOwnerOnly(true, 'timeline_entries') });
  for (const q of MEMBER_READS) {
    out.push({ request: { mode: 'member_access_policy', identity: q.identity, satisfied: q.satisfied }, run: () => memberAccessPolicy(q.identity, q.satisfied) });
  }
  out.push({ request: { mode: 'member_access_policy', satisfied: ['wiki:team'] }, run: () => memberAccessPolicy(null, ['wiki:team']) });
  for (const w of WRITERS) out.push({ request: { mode: 'writer_policy', policy: w }, run: () => writerPolicy(w) });
  for (const r of SNAPSHOT_READERS) {
    out.push({ request: { mode: 'snapshot_policy', ...r }, run: () => snapshotServed('m', r) });
  }
  out.push({ request: { mode: 'member_access' }, run: async () => {
    const { brain, sent } = recordingBrain();
    await readPageHiddenFromCaller(brain as never, 'wiki', 'x', { policy: 'access' });
    return sent[0];
  } });
  out.push({ request: { mode: 'privacy_part_aliases' }, run: async () => {
    const { brain, sent } = recordingBrain();
    await readPagePrivacyHidden(brain as never, 'wiki', 'x');
    return sent[0];
  } });
  return out;
}

/** The comparable outcome of a TypeScript helper (as access-self-check.ts compares it). */
async function tsOutcome(run: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    const v = await run();
    return v === undefined ? { $none: true } : JSON.parse(JSON.stringify(v));
  } catch (error) {
    if ((error as { code?: string }).code === 'engine_capability_missing') return { $refuse: true };
    throw error;
  }
}

function storeOutcome(request: AccessDeriveRequest): unknown {
  const got = derive(accessDeriveContext(request)) as Record<string, unknown>;
  return got && got.$refuse === true ? { $refuse: true } : got;
}

/** Sets the aliases setting through the reader every remote read runs (readHonorAliases). */
async function setHonorAliases(on: boolean): Promise<void> {
  __resetPrivateVisibilityCacheForTests();
  const engine = { kind: 'pglite', getConfig: async () => (on ? null : 'false') } as unknown as BrainEngine;
  await readHonorAliases(engine);
}

interface Mismatch { index: number; settings: string; patch: unknown; request: AccessDeriveRequest; ts: unknown; store: unknown; at: string }

async function runCorpus(records: Array<Partial<CallerAccess> | null>, settings: string): Promise<{ compared: number; mismatches: Mismatch[] }> {
  const all = cases();
  const mismatches: Mismatch[] = [];
  let compared = 0;
  for (let i = 0; i < records.length; i++) {
    const patch = records[i]!;
    for (const c of all) {
      const once = async () => {
        if (c.request.mode === 'page_text' && c.request.renderedIn) {
          const record = JSON.parse(JSON.stringify(callerAccessRecord()));
          const text = PAGE_THUNKS.plain();
          const request = { ...c.request, renderedIn: { record } };
          return withCallerAccess({ identity: [], privateReadableSources: [] }, async () => ({
            ts: await tsOutcome(() => storePageTextPolicy('m', () => text, { callerReaders: true, fragment: 'plain', renderedIn: { record } })),
            store: storeOutcome(request),
          }));
        }
        const ts = await tsOutcome(c.run);
        const store = storeOutcome(c.request);
        return { ts, store };
      };
      const { ts, store } = patch === null ? await once() : await withCallerAccess(patch, once);
      compared++;
      const at = firstDifference(ts, store);
      if (at !== null) mismatches.push({ index: i, settings, patch, request: c.request, ts, store, at });
    }
  }
  return { compared, mismatches };
}

/**
 * The one divergence the store is allowed: an explicit member-read identity that fails validIdentity. TypeScript's
 * `named` test reads the SQL text for the identity's quoted ids, which an invalid id may match by accident; the store
 * refuses every invalid identity instead. The store side must be the refusal, never a wider answer.
 */
function allowed(m: Mismatch): boolean {
  if (m.request.mode !== 'member_read') return false;
  const q = m.request;
  const invalid = q.identity.some(id => !/^(member|group):[a-z0-9][a-z0-9._-]{0,63}$/.test(id));
  return invalid && (m.store as { $refuse?: boolean }).$refuse === true;
}

function report(mismatches: Mismatch[]): string {
  return JSON.stringify(mismatches.slice(0, 8), null, 1);
}

describe('store access derivation equals the TypeScript policy helpers', () => {
  const r = rng(20261125);
  const random = Array.from({ length: 400 }, () => drawPatch(r));
  const records = [...EDGE_PATCHES, ...random];

  for (const honor of [true, false]) {
    for (const relaxed of [false, true]) {
      test(`every request over ${records.length} records (honor_aliases ${honor}, process privacy relaxed ${relaxed})`, async () => {
        await setHonorAliases(honor);
        if (relaxed) process.env.GBRAIN_REMOTE_PRIVATE_PAGES = '1'; else delete process.env.GBRAIN_REMOTE_PRIVATE_PAGES;
        try {
          const { compared, mismatches } = await runCorpus(records, `honor=${honor} relaxed=${relaxed}`);
          const real = mismatches.filter(m => !allowed(m));
          expect(compared).toBe(records.length * cases().length);
          if (real.length) throw new Error(`${real.length} of ${compared} outcomes differ; first:\n${report(real)}`);
        } finally {
          delete process.env.GBRAIN_REMOTE_PRIVATE_PAGES;
        }
      }, 300_000);
    }
  }

  test('the corpus reaches every outcome kind (a served policy, an absent one and a refusal) in each mode', async () => {
    await setHonorAliases(true);
    const seen = new Map<string, Set<string>>();
    for (const patch of records) {
      for (const c of cases().filter(c => !(c.request.mode === 'page_text' && c.request.renderedIn))) {
        const out = patch === null ? storeOutcome(c.request) : withCallerAccess(patch, () => storeOutcome(c.request));
        const kind = (out as { $refuse?: boolean }).$refuse ? 'refuse' : (out as { $none?: boolean }).$none ? 'none' : 'value';
        const key = c.request.mode;
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key)!.add(kind);
      }
    }
    for (const mode of ['page_text', 'fact', 'floor_policy', 'member_read', 'member_access', 'remote_floor', 'visibility',
      'plain_page_flags', 'open_page_floor', 'access_part_plain', 'row_owner_only', 'member_access_policy', 'writer_policy', 'snapshot_policy']) {
      expect({ mode, value: seen.get(mode)?.has('value') }).toEqual({ mode, value: true });
    }
    for (const mode of ['open_page_floor', 'access_part_plain', 'writer_policy', 'snapshot_policy']) {
      expect({ mode, refuse: seen.get(mode)?.has('refuse') }).toEqual({ mode, refuse: true });
    }
    for (const mode of ['page_text', 'fact', 'floor_policy', 'member_read', 'member_access', 'remote_floor', 'visibility']) {
      expect({ mode, refuse: seen.get(mode)?.has('refuse') }).toEqual({ mode, refuse: true });
    }
    expect(seen.get('fact')?.has('none')).toBe(true);
  }, 300_000);

  test('the corpus is not trivial: each mode reaches many distinct served answers', async () => {
    await setHonorAliases(true);
    const distinct = new Map<string, Set<string>>();
    for (const patch of records) {
      for (const c of cases().filter(c => !(c.request.mode === 'page_text' && c.request.renderedIn))) {
        const out = patch === null ? storeOutcome(c.request) : withCallerAccess(patch, () => storeOutcome(c.request));
        if ((out as { $refuse?: boolean }).$refuse) continue;
        if (!distinct.has(c.request.mode)) distinct.set(c.request.mode, new Set());
        distinct.get(c.request.mode)!.add(JSON.stringify(out));
      }
    }
    const counts = Object.fromEntries([...distinct].map(([k, v]) => [k, v.size]));
    // A floor reads no identity, so it has few answers; the caller policies have many.
    expect(counts.page_text).toBeGreaterThan(20);
    expect(counts.fact).toBeGreaterThan(20);
    expect(counts.visibility).toBeGreaterThan(5);
    expect(counts.member_access).toBeGreaterThan(5);
    expect(counts.member_read).toBeGreaterThan(3);
    expect(counts.remote_floor).toBeGreaterThan(2);
  }, 300_000);
});

describe('the self-check refuses before the store is called', () => {
  const on = () => { process.env.GBRAIN_RUST_MULTIUSER = '1'; process.env.GBRAIN_RUST_ACCESS_SELF_CHECK = '1'; };
  const off = () => { delete process.env.GBRAIN_RUST_MULTIUSER; delete process.env.GBRAIN_RUST_ACCESS_SELF_CHECK; };
  /** A served member's context: a store with no answer of its own (the environment's) and the addon `deriveAccessPolicy`. */
  const served = <T>(deriveAccessPolicy: unknown, fn: () => T): T => withAccessStore({}, { deriveAccessPolicy }, fn);
  const thrown = (fn: () => unknown): unknown => { try { fn(); return null; } catch (e) { return e; } };

  test('agreeing answers serve the read unchanged', async () => {
    on();
    try {
      const { brain, sent } = recordingBrain();
      await served(derive, () => withCallerAccess({ identity: ['member:alice-example'] }, () => readPageHiddenFromCaller(brain as never, 'wiki', 'x', { policy: 'read' })));
      off();
      const plain = recordingBrain();
      await withCallerAccess({ identity: ['member:alice-example'] }, () => readPageHiddenFromCaller(plain.brain as never, 'wiki', 'x', { policy: 'read' }));
      expect(sent).toEqual(plain.sent);
      expect(sent.length).toBe(1);
    } finally { off(); }
  });

  test('a store answer that differs in one field refuses access_self_check_mismatch and reads nothing', async () => {
    on();
    try {
      const tampered = (ctx: unknown) => ({ ...(derive(ctx) as Record<string, unknown>), identity: ['member:mallory'] });
      const { brain, sent } = recordingBrain();
      const err = await served(tampered, () => withCallerAccess({ identity: ['member:alice-example'] },
        () => readPageHiddenFromCaller(brain as never, 'wiki', 'x', { policy: 'read' }))).catch(e => e);
      expect((err as { code?: string }).code).toBe('access_self_check_mismatch');
      expect(String((err as Error).message)).toContain('$.identity');
      expect(sent).toEqual([]);
    } finally { off(); }
  });

  test('a store that would serve what TypeScript refuses still refuses (a refusal is compared too)', () => {
    on();
    try {
      const widening = () => ({ honorAliases: true, entityPrivacy: true, ownerOnly: 'off' });
      const err = thrown(() => served(widening, () => withCallerAccess({ identity: ['member:alice-example'], lineage: true },
        () => storePageTextPolicy('m', PAGE_THUNKS.caller, { callerReaders: true, fragment: 'caller' }))));
      expect((err as { code?: string }).code).toBe('access_self_check_mismatch');
    } finally { off(); }
  });

  test('no derivation in context refuses (fail closed)', () => {
    on();
    try {
      const err = thrown(() => served(undefined, () => storeFloorPolicy('m')));
      expect((err as { code?: string }).code).toBe('access_self_check_mismatch');
    } finally { off(); }
  });

  test('a fragment label that does not render the call site text refuses', () => {
    on();
    try {
      const mislabelled = () => served(derive, () => withCallerAccess({ identity: ['member:alice-example'], labelledOnly: true },
        () => storePageTextPolicy('m', PAGE_THUNKS.floor, { callerReaders: true, fragment: 'plain' })));
      expect(mislabelled).toThrow(/\$fragment/);
      const unlabelled = () => served(derive, () => storePrivacyPolicy('m', true, FACT_THUNKS.for_caller, { callerReaders: true }));
      expect(unlabelled).toThrow(/\$fragment/);
    } finally { off(); }
  });

  test('the sub-switch without the main switch, or a store not in multi-user mode, changes nothing', () => {
    try {
      process.env.GBRAIN_RUST_ACCESS_SELF_CHECK = '1';
      const wrong = () => ({ wrong: true });
      expect(served(wrong, () => storeFloorPolicy('m'))).toEqual(storeFloorPolicy('m'));
      process.env.GBRAIN_RUST_MULTIUSER = '1';
      expect(withAccessStore({ multiuser: false }, { deriveAccessPolicy: wrong }, () => storeFloorPolicy('m'))).toEqual(storeFloorPolicy('m'));
      expect(thrown(() => withAccessStore({ multiuser: true }, { deriveAccessPolicy: wrong }, () => storeFloorPolicy('m')))).not.toBeNull();
    } finally { off(); }
  });
});
