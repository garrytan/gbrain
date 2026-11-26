/**
 * Multi-user lane L4: the caller record the Rust store builds for a token (rust/crates/gbrain-store/src/access_record.rs,
 * napi `tokenCallerRecord`) equals the record `remoteCallerAccess` builds from the same brain (src/core/access/caller.ts),
 * over configs, members, groups, folder rules, labelled-only and audience members, read-only and write calls, private
 * sources and the process privacy hatch. Compared raw (every field the store sets) and after `withCallerAccess`
 * normalization (what the policy derivation reads).
 *
 * Needs the addon `bun run rust:build` writes (or GBRAIN_TEST_RUST_ENGINE_ADDON).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { remoteCallerAccess } from '../src/core/access/caller.ts';
import { __resetPrivateVisibilityCacheForTests, callerAccessRecord, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { hashToken } from '../src/core/utils.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { rustArmAddonPath } from './engine-parity/rust-arm.ts';

let engine: RustEngine;
let dir: string;
const tokens: Record<string, { id: string; secret: string }> = {};
const saved = process.env.GBRAIN_REMOTE_PRIVATE_PAGES;
type Brain = Record<string, (...a: unknown[]) => Promise<unknown>>;
const brain = () => engine.openStore('access-record-test').brain as unknown as Brain;

async function token(name: string, member: string | null): Promise<void> {
  const secret = `secret-${name}`;
  const { id } = await (engine as unknown as { insertAccessToken(r: unknown): Promise<{ id: string }> })
    .insertAccessToken({ name, token_hash: hashToken(secret), scopes: ['read', 'write'], permissions: {}, member_id: member });
  tokens[name] = { id, secret };
}

beforeAll(async () => {
  delete process.env.GBRAIN_REMOTE_PRIVATE_PAGES;
  dir = mkdtempSync(join(tmpdir(), 'gbrain-access-record-'));
  engine = openRustEngine({ addon: await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: rustArmAddonPath() } }), databasePath: join(dir, 'db') });
  await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
  await engine.initSchema();
  const member = (id: string, groups: string[] = []) =>
    engine.insertAccessMember({ id, displayName: null, email: null, kind: 'person' as never, groups, bindTokenId: null });
  await member('owner-example', ['team-a']);
  await member('alice-example', ['team-a', 'team-b']);
  await member('bob-example');
  await member('room-example');
  await member('gone-example');
  await engine.setAccessMemberKind('room-example', 'audience' as never);
  await engine.setAccessMemberLabelledOnly('bob-example', true);
  await engine.setAccessMemberDisabled('gone-example', true);
  for (const [name, m] of [['owner', 'owner-example'], ['alice', 'alice-example'], ['bob', 'bob-example'], ['room', 'room-example'],
    ['gone', 'gone-example'], ['unbound', null]] as const) await token(name, m);
  const b = brain();
  await b.putAccessPolicyState('default');
  await b.putAccessRule({ source_id: 'default', rule_id: 'team', prefix: 'team/', readable_by: ['group:team-a'], revision: 1 });
  await b.putAccessRule({ source_id: 'default', rule_id: 'alice', prefix: 'alice/', readable_by: ['member:alice-example'], revision: 1 });
  await b.putAccessPendingCoverage({ source_id: 'default', prefix: 'pending/', reason: 'pending' });
});

afterAll(async () => {
  await engine?.disconnect();
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.GBRAIN_REMOTE_PRIVATE_PAGES; else process.env.GBRAIN_REMOTE_PRIVATE_PAGES = saved;
  __resetPrivateVisibilityCacheForTests();
});

/** The fields the store sets, with the remote policy cut to the fields it builds (serves is TypeScript-only). */
function comparable(record: Record<string, unknown>): Record<string, unknown> {
  const rp = (record.remotePolicy ?? {}) as Record<string, unknown>;
  const { serves: _serves, servesUnknown: _unknown, ...policy } = rp;
  return { ...record, privateFactSources: record.privateFactSources ?? [], remotePolicy: policy };
}

const SCENARIOS: Array<{ name: string; config: Record<string, string | null>; hatch?: boolean }> = [
  { name: 'no restriction, no owner', config: {} },
  { name: 'restricted, no owner', config: { 'access.restrictions_present': '1' } },
  { name: 'owner, not restricted', config: { 'access.owner_member': 'owner-example' } },
  { name: 'restricted with owner', config: { 'access.restrictions_present': '1', 'access.owner_member': ' owner-example ' } },
  { name: 'owner reads restricted, lineage for members', config: { 'access.restrictions_present': '1', 'access.owner_member': 'owner-example',
    'access.owner_reads_restricted': '1', 'access.members_read_lineage': ' 1' } },
  { name: 'relaxed remote privacy', config: { 'access.restrictions_present': '1', 'access.owner_member': 'owner-example', 'search.remote_private_pages': 'visible' } },
  { name: 'process privacy hatch', config: { 'access.restrictions_present': '1', 'access.owner_member': 'owner-example' }, hatch: true },
  { name: 'invalid owner id, odd schema version', config: { 'access.restrictions_present': '1', 'access.owner_member': 'Not Valid', version: '  328x' } },
  { name: 'restriction flag not exactly 1', config: { 'access.restrictions_present': ' 1', 'access.owner_member': 'owner-example' } },
];
const KEYS = ['access.restrictions_present', 'access.owner_member', 'access.owner_reads_restricted', 'access.members_read_lineage', 'search.remote_private_pages', 'version'];

describe('the store builds the caller record remoteCallerAccess builds', () => {
  for (const sc of SCENARIOS) {
    test(sc.name, async () => {
      for (const k of KEYS) {
        if (k === 'version' && sc.config.version === undefined) continue;
        const v = sc.config[k];
        if (v === undefined || v === null) await engine.unsetConfig(k);
        else await engine.setConfig(k, v);
      }
      if (sc.hatch) process.env.GBRAIN_REMOTE_PRIVATE_PAGES = '1'; else delete process.env.GBRAIN_REMOTE_PRIVATE_PAGES;
      __resetPrivateVisibilityCacheForTests();
      let compared = 0;
      try {
        for (const [name, t] of Object.entries(tokens)) {
          for (const readOnly of [true, false]) {
            for (const sources of [[], ['default']]) {
              const auth = { principal: { kind: 'legacy_token', id: t.id } } as unknown as AuthInfo;
              const ts = await remoteCallerAccess(engine, auth, sources, 'http', null, undefined, readOnly) as Record<string, unknown>;
              const rust = await brain().tokenCallerRecord(t.secret, { readOnly, privateReadableSources: sources, privateFactSources: [],
                processPrivacyRelaxed: sc.hatch === true }) as Record<string, unknown>;
              const label = `${sc.name} / ${name} / readOnly=${readOnly} / sources=${sources.join(',')}`;
              expect({ label, record: comparable(rust) }).toEqual({ label, record: comparable({ ...ts, privateFactSources: [] }) });
              const norm = (r: Record<string, unknown>) => withCallerAccess(r as never, () => JSON.parse(JSON.stringify(callerAccessRecord())));
              expect({ label, normalized: comparable(norm(rust)) }).toEqual({ label, normalized: comparable(norm(ts)) });
              compared++;
            }
          }
        }
      } finally {
        delete process.env.GBRAIN_REMOTE_PRIVATE_PAGES;
      }
      expect(compared).toBe(Object.keys(tokens).length * 4);
    });
  }

  test('the corpus reaches owners, lineage, labelled-only, folder rules and audience members', async () => {
    await engine.setConfig('access.restrictions_present', '1');
    await engine.setConfig('access.owner_member', 'owner-example');
    await engine.setConfig('access.owner_reads_restricted', '1');
    __resetPrivateVisibilityCacheForTests();
    const rec = (name: string, readOnly = true) => brain().tokenCallerRecord(tokens[name]!.secret, { readOnly }) as Promise<Record<string, unknown>>;
    const owner = await rec('owner');
    expect(owner).toMatchObject({ owner: true, lineage: true, ownerReadsRestricted: true, audienceKindMembers: ['room-example'], hidePrivate: false });
    expect(await rec('alice')).toMatchObject({ identity: ['group:team-a', 'group:team-b', 'member:alice-example'], satisfiedRuleIds: ['default:alice', 'default:team'],
      folderCoverage: [{ source_id: 'default', prefix: 'pending/' }] });
    expect(await rec('bob')).toMatchObject({ labelledOnly: true });
    expect(await rec('gone')).toMatchObject({ identity: [] });
    expect(await rec('unbound')).toMatchObject({ identity: [], owner: false });
    expect(await rec('owner', false)).toMatchObject({ lineage: false, audienceKindMembers: [] });
  });
});
