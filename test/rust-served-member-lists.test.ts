/**
 * The served member lists guard (multi-user lane L3): every engine member a served client could need for a remote caller
 * is classified, so a member a main merge adds cannot fall through to a refusal on the served arms unnoticed.
 *
 * 1. Protects: each store-returning BrainEngine member (`<name>(): Promise<…Store>`) is served
 *    (served/store-returning.ts STORE_RETURNING_MEMBERS) or listed local-only; each typed read
 *    (owner-ipc/typed-member-classes.ts OWNER_IPC_TYPED_READS) is a remote read (OWNER_IPC_REMOTE_READS: the frozen hand
 *    list and OWNER_IPC_REMOTE_TYPED_READS), denied (OWNER_IPC_REMOTE_DENY) or listed local-only. The local-only list is
 *    test/fixtures/served-member-lists/local-only.tsv, one row per member with a one-line reason.
 * 2. Fails on: a new store-returning member or typed read on none of these lists (the failure names it; the persistence
 *    upkeep store and ten entity and version reads arrived this way and refused on the served arms), a local-only row for
 *    a member that is gone or is also served, remote or denied, a row with no reason, or any change to the set of members
 *    under the frozen baseline reason other than the one this file pins: a new row, and also a swap (one baseline row out,
 *    a new member in under the same reason), which keeps the count.
 * 3. Existing coverage: rust-owner-ipc-remote.test.ts checks every remote read is a typed or frozen hand read and never
 *    a write; rust-served-store-returning.serial.test.ts checks the managed stores are served. Neither fails when a new
 *    member joins no list.
 * 4. Seam: none; the lists and the engine member declarations as they are. Writes are out of scope: a remote caller's
 *    single member write is always refused, and its whole operations are the closed list of served/remote-whole-ops.ts.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { STORE_RETURNING_MEMBERS } from '../src/core/rust-engine/served/store-returning.ts';
import { OWNER_IPC_REMOTE_DENY, OWNER_IPC_REMOTE_READS } from '../src/core/rust-engine/owner-ipc/routes.ts';
import { OWNER_IPC_TYPED_READS } from '../src/core/rust-engine/owner-ipc/typed-member-classes.ts';

const ROOT = join(import.meta.dir, '..');
const LOCAL_ONLY_FILE = 'test/fixtures/served-member-lists/local-only.tsv';
/** The frozen baseline reason (multiuser d0a230d4ac, 2026-11-28): no served parity file proves the member remotely. */
const BASELINE_REASON = 'ruling A default';
/**
 * The baseline member set, pinned by its size and a sha256 of its sorted names joined by newlines. Lower
 * BASELINE_FROZEN_SIZE and update BASELINE_DIGEST only in the commit that moves a row out of the baseline reason; never to
 * add a member. A new local-only member takes its own real reason.
 */
const BASELINE_FROZEN_SIZE = 547;
const BASELINE_DIGEST = '589f2d896c4d714ec7dc227ec68cb0c78cc2183f697ca9eeddc212448f40e1e8';

const localOnlyRows = readFileSync(join(ROOT, LOCAL_ONLY_FILE), 'utf8').split('\n')
  .filter(line => line !== '' && !line.startsWith('#') && line !== 'member\treason')
  .map(line => { const [member = '', reason = ''] = line.split('\t'); return { member, reason: reason.trim() }; });
const LOCAL_ONLY = new Map(localOnlyRows.map(row => [row.member, row.reason]));

/** BrainEngine members declared as `<name>(…): Promise<…Store>;` in engine.ts and the engine-members files. */
function declaredStoreMembers(): string[] {
  const files = ['src/core/engine.ts', ...readdirSync(join(ROOT, 'src/core/engine-members')).filter(f => f.endsWith('.ts')).map(f => `src/core/engine-members/${f}`)];
  const found = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(join(ROOT, file), 'utf8').matchAll(/^\s+(\w+)\([^)]*\):\s*Promise<\w+Store>;/gm)) found.add(match[1]!);
  }
  return [...found].sort();
}

interface Lists { stores: Iterable<string>; typedReads: Iterable<string>; served: ReadonlySet<string>; remote: ReadonlySet<string>; deny: Readonly<Record<string, string>>; localOnly: ReadonlyMap<string, string> }

/** Each member on no list, named with what it is. */
function unclassified(lists: Lists): string[] {
  const problems: string[] = [];
  for (const member of lists.stores) {
    if (!lists.served.has(member) && !lists.localOnly.has(member)) problems.push(`${member}: a store-returning member on neither STORE_RETURNING_MEMBERS nor ${LOCAL_ONLY_FILE}`);
  }
  for (const member of new Set(lists.typedReads)) {
    if (!lists.remote.has(member) && !Object.hasOwn(lists.deny, member) && !lists.localOnly.has(member)) {
      problems.push(`${member}: a typed read on none of OWNER_IPC_REMOTE_TYPED_READS, OWNER_IPC_REMOTE_DENY and ${LOCAL_ONLY_FILE}`);
    }
  }
  return problems;
}

/** How the rows under the baseline reason differ from the pinned set: its size, then its digest. */
function baselineDrift(rows: readonly { member: string; reason: string }[]): string[] {
  const names = rows.filter(row => row.reason === BASELINE_REASON).map(row => row.member).sort();
  const digest = createHash('sha256').update(names.join('\n')).digest('hex');
  return [
    ...(names.length !== BASELINE_FROZEN_SIZE ? [`${names.length} rows under '${BASELINE_REASON}', not ${BASELINE_FROZEN_SIZE}`] : []),
    ...(digest !== BASELINE_DIGEST ? [`the members under '${BASELINE_REASON}' are not the pinned set (sha256 ${digest})`] : []),
  ];
}

const REAL: Lists = { stores: declaredStoreMembers(), typedReads: OWNER_IPC_TYPED_READS, served: STORE_RETURNING_MEMBERS, remote: OWNER_IPC_REMOTE_READS, deny: OWNER_IPC_REMOTE_DENY, localOnly: LOCAL_ONLY };

describe('the served member lists guard', () => {
  test('every store-returning member and every typed read is served, remote, denied or listed local-only with a reason', () => {
    expect(unclassified(REAL)).toEqual([]);
  });

  test('the declaration scan sees every served store, and only engine members', () => {
    const stores = declaredStoreMembers();
    expect([...STORE_RETURNING_MEMBERS].filter(member => !stores.includes(member))).toEqual([]);
    expect(stores.filter(member => !Object.hasOwn(RUST_ENGINE_MEMBERS, member))).toEqual([]);
  });

  test('each local-only row is a current store-returning member or typed read on no other list, with a reason', () => {
    const stores = new Set(declaredStoreMembers());
    const typed = new Set(OWNER_IPC_TYPED_READS);
    const bad = localOnlyRows.flatMap(({ member, reason }) => [
      ...(!stores.has(member) && !typed.has(member) ? [`${member}: not a store-returning member or a typed read`] : []),
      ...(STORE_RETURNING_MEMBERS.has(member) || OWNER_IPC_REMOTE_READS.has(member) || Object.hasOwn(OWNER_IPC_REMOTE_DENY, member) ? [`${member}: also served, remote or denied`] : []),
      ...(reason === '' ? [`${member}: no reason`] : []),
    ]);
    expect(bad).toEqual([]);
  });

  test('the rows are sorted and unique, and the members under the frozen baseline reason are the pinned set', () => {
    const names = localOnlyRows.map(row => row.member);
    expect(names).toEqual([...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(baselineDrift(localOnlyRows)).toEqual([]);
  });

  test('the baseline pin refuses a swap: one baseline row out and a new member in under the same reason', () => {
    const [out, ...kept] = localOnlyRows.filter(row => row.reason === BASELINE_REASON);
    const swapped = [...kept, { member: 'readNewThing', reason: BASELINE_REASON }];
    expect(out).toBeDefined();
    expect(swapped.length).toBe(BASELINE_FROZEN_SIZE);
    expect(baselineDrift(swapped)).toEqual([expect.stringContaining(`the members under '${BASELINE_REASON}' are not the pinned set`)]);
    expect(baselineDrift([...localOnlyRows, { member: 'readNewThing', reason: BASELINE_REASON }]).length).toBe(2);
  });

  test('the guard names a new store-returning member and a new typed read that join no list', () => {
    const served = new Set([...STORE_RETURNING_MEMBERS].filter(member => member !== 'persistenceUpkeepStore'));
    const remote = new Set([...OWNER_IPC_REMOTE_READS].filter(member => member !== 'rankEntities'));
    expect(unclassified({ ...REAL, served, remote })).toEqual([
      `persistenceUpkeepStore: a store-returning member on neither STORE_RETURNING_MEMBERS nor ${LOCAL_ONLY_FILE}`,
      `rankEntities: a typed read on none of OWNER_IPC_REMOTE_TYPED_READS, OWNER_IPC_REMOTE_DENY and ${LOCAL_ONLY_FILE}`,
    ]);
    expect(unclassified({ ...REAL, typedReads: [...OWNER_IPC_TYPED_READS, 'readNewThing'] }))
      .toEqual([`readNewThing: a typed read on none of OWNER_IPC_REMOTE_TYPED_READS, OWNER_IPC_REMOTE_DENY and ${LOCAL_ONLY_FILE}`]);
  });
});
