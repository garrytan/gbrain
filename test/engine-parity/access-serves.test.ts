/**
 * BrainEngine parity — `gbrain access serves several` (src/commands/access-serves.ts labelSeveral): the preview and the
 * `--yes` run that add the members, one folder rule `people/<member>/` per member, and one member key per member,
 * and the token list `gbrain auth list` reads (listAccessTokens).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1), the preview writes nothing, and the run labels each member's people folder so another
 *    member reads none of its pages, mints each member key with the same reads, and lists every token with every
 *    column `SELECT *` returns.
 *  - Regression: on a Rust brain the command stopped on a typed refusal before any write (row 32b-2), and the token
 *    list refused once a token existed (row 32g), so a several-person Rust brain could not label its people folders and
 *    every member would read every other member's folder.
 *  - Why existing coverage misses it: test/setup-serves-several.test.ts runs on the SQL engines only, and the parity
 *    pin in access-reports.test.ts only checks the refusal text.
 *  - Seam: none. The run goes through labelSeveral with GBRAIN_HOME in a temp dir; pages through putPage.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { keysStillReading, labelSeveral, type ServesReceipt } from '../../src/commands/access-serves.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import { addMember } from '../../src/core/access/members.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest, arms } = parityArms(testBackends());

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), 'gbrain-serves-parity-')); homes.push(h); return h; };

const core = (title: string) =>
  ({ type: 'note' as const, title, compiled_truth: `body ${title}`, timeline: '', frontmatter: { always_load: true } });

/** One people folder page per member and one open page. */
async function seed(engine: BrainEngine): Promise<void> {
  await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
  await engine.putPage('people/alice-example/notes', core('Alice notes'), { sourceId: 'default' });
  await engine.putPage('people/bob-example/notes', core('Bob notes'), { sourceId: 'default' });
  await engine.putPage('notes/open', core('Open'), { sourceId: 'default' });
}

/** labelSeveral with the member keys in a fresh temp GBRAIN_HOME. */
const run = (engine: BrainEngine, apply: boolean, dir: string) =>
  withEnv({ GBRAIN_HOME: dir, GBRAIN_SETUP_ABORT_AFTER: undefined }, () =>
    labelSeveral(engine, ['alice-example', 'bob-example'], 'default', apply, true));

/** The always-loaded pages a stdio server bound to `member` reads under its caller record. */
async function readAs(engine: BrainEngine, member: string): Promise<string[]> {
  await engine.setConfig('mcp.stdio_member', member);
  const access = await remoteCallerAccess(engine, undefined, [], 'stdio');
  const rows = await withCallerAccess(access, () => engine.listCorePageRows({ excludePrivate: true, forCaller: true, limit: 50 }));
  return rows.map(r => r.slug).sort();
}

/** The receipt less its paths and timing, so every arm compares. */
const shape = (r: ServesReceipt) => ({
  applied: r.applied,
  config: r.config,
  members: r.members,
  rules: r.rules.map(x => ({ id: x.id, prefix: x.prefix, readers: x.readers, action: x.action })),
  keys: r.keys.map(k => ({ member: k.member, token_name: k.token_name, action: k.action, reads: k.reads })),
  reads: r.reads,
  completed: r.completed,
});

describe('engine parity: gbrain access serves several', () => {
  // The read-side leak, first: once the run labels the people folders, a member reads none of another's pages.
  parityTest('the run keeps each member\'s people folder from the other member, and the preview writes nothing', {
    methods: ['listCorePageRows', 'listAccessTokens'],
  }, async (engine) => {
    await seed(engine);
    const dir = home();
    const preview = shape(await run(engine, false, dir));
    const tokensAfterPreview = (await engine.listAccessTokens()).length;
    const applied = shape(await run(engine, true, dir));
    const reads = { alice: await readAs(engine, 'alice-example'), bob: await readAs(engine, 'bob-example') };
    expect(tokensAfterPreview).toBe(0);
    expect(reads.bob).toEqual(['notes/open', 'people/bob-example/notes']);
    expect(reads.alice).toEqual(['notes/open', 'people/alice-example/notes']);
    return { preview, applied, reads };
  });

  // The rest of the setup reads: the company source counts, the owner run's unbound credentials, a re-run that keeps
  // the keys (the live key read and the key file check), the unlabeled people folders, and the keys still reading a
  // source (`gbrain sources unfederate`).
  parityTest('an owner run with a company source lists unbound tokens and counts, and a re-run keeps every key', {
    methods: ['listUnboundTokenNames', 'listUnboundClientIds', 'readLiveAccessToken', 'recordTokenSetupReads', 'countCompanyPages', 'countPeopleFolderPages', 'listKeysReadingSource'],
  }, async (engine, backend) => {
    await seed(engine);
    await createSource(engine, backend, 'company');
    await engine.putPage('company/calls/2026-01-02-kickoff', core('Kickoff'), { sourceId: 'company' });
    await engine.putPage('company/handbook', core('Handbook'), { sourceId: 'company' });
    await engine.putPage('people/carol-example/notes', core('Carol notes'), { sourceId: 'default' });
    await engine.insertAccessToken({ name: 'laptop', token_hash: 'hash-laptop', scopes: ['read'], permissions: {}, source_grant: null, source_id: null,
      federated_read: null, allowed_operations: null, takes_holders: null });
    const dir = home();
    const first = await withEnv({ GBRAIN_HOME: dir, GBRAIN_SETUP_ABORT_AFTER: undefined }, () =>
      labelSeveral(engine, ['alice-example', 'bob-example'], 'default', true, true, { owner: 'alice-example' }));
    const again = shape(await run(engine, true, dir));
    const company = await keysStillReading(engine, 'company');
    expect(first.unbound?.map(u => u.name)).toEqual(['laptop']);
    expect(first.reads?.company).toEqual({ pages: 2, calls: 1 });
    expect(again.keys.map(k => k.action)).toEqual(['keep', 'keep']);
    return { first: { ...shape(first), unbound: first.unbound, unlabeled: first.unlabeled }, again, company };
  });

  // Row 32g: the token list carries every column `SELECT *` returns, with the same values, on every arm.
  parityTest('gbrain auth list reads every column of each member key the run minted', {
    methods: ['listAccessTokens'],
  }, async (engine) => {
    await seed(engine);
    await run(engine, true, home());
    const rows = await engine.listAccessTokens();
    const volatile = new Set(['id', 'token_hash', 'created_at', 'last_used_at']);
    const listed = rows.map(r => Object.fromEntries(Object.keys(r).sort().map(k => [k, volatile.has(k) ? (r[k] === null ? null : typeof r[k]) : r[k]])))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(listed.map(r => r.name)).toEqual(['member-alice-example', 'member-bob-example']);
    return listed;
  });
});

describe('engine parity: the token list carries every column (row 32g)', () => {
  // Every column `SELECT *` returns, with the same value on every arm: a live token on every grant column with a
  // read floor and the read-shared switch, bound to a member, and a revoked one. Only the generated id, the time of
  // birth and the hash are compared by kind.
  parityTest('listAccessTokens returns every column of a bound token and a revoked token', {
    methods: ['insertAccessToken', 'listAccessTokens', 'revokeAccessTokenById'],
  }, async (engine) => {
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    await engine.insertAccessToken({ name: 'laptop', token_hash: 'hash-laptop', scopes: ['read', 'write'], permissions: { setup_reads: ['default'] },
      source_grant: 'federated', source_id: 'default', federated_read: ['default', 'team'], allowed_operations: ['query'], takes_holders: ['world'],
      read_shared: true, min_trust: 'agent_written' });
    const old = await engine.insertAccessToken({ name: 'old', token_hash: 'hash-old', scopes: ['read'], permissions: {}, source_grant: null, source_id: null,
      federated_read: null, allowed_operations: null, takes_holders: null });
    await addMember(engine, 'alice-example', { bindToken: 'laptop' });
    await engine.revokeAccessTokenById(old.id);
    const volatile = new Set(['id', 'created_at']);
    const listed = (await engine.listAccessTokens())
      .map(r => Object.fromEntries(Object.keys(r).sort().map(k => [k, volatile.has(k) ? typeof r[k] : k === 'revoked_at' ? r[k] !== null : r[k]])))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(listed.map(r => r.name)).toEqual(['laptop', 'old']);
    return listed;
  });
});

describe('the Rust arm serves gbrain access serves several', () => {
  // A parity case counts a typed refusal as a pass, so this reads the Rust arm's own engine: it is red while the run
  // stops on Rust, and it must never let one member read another's people folder.
  test('a run on Rust labels each people folder, and bob reads none of alice\'s pages', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    await seed(rust.engine);
    const receipt = await run(rust.engine, true, home());
    expect(receipt.completed).toContain('keys');
    expect(await readAs(rust.engine, 'bob-example')).toEqual(['notes/open', 'people/bob-example/notes']);
    expect((await rust.engine.listAccessTokens()).map(r => r.name).sort()).toEqual(['member-alice-example', 'member-bob-example']);
  });
});
