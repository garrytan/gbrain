/**
 * BrainEngine parity — the core-memory page list behind `context_pack` for a member caller.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: under `excludePrivate`, listCorePageRows lists the live `always_load` pages the caller may read. With
 *    `forCaller` that is the caller's page policy (`privatePagesFilterForCaller`): a member whose identity a page's
 *    readers name reads that page, a private-readable grant opens the private pages of its source, a stranger reads
 *    neither. Without it the read is the remote floor (`remoteReadFloorSql`), which hides both from every caller.
 *  - Regression: the Rust arm refused a caller with a reader identity or a grant on both forms, so `context_pack`
 *    failed for such a caller while PGLite answered.
 *  - Why existing coverage misses it: trust-tier-reads.test.ts reads the core list with no caller record.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { runCore } from '../../src/commands/core.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withEnv } from '../helpers/with-env.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const { parityTest } = parityArms(testBackends());

const core = (frontmatter: Record<string, unknown>) =>
  ({ type: 'note' as const, title: 'Core', compiled_truth: `body ${JSON.stringify(frontmatter)}`, timeline: '', frontmatter: { always_load: true, ...frontmatter } });

/** The callers each read runs as: none, a member the readers name, a stranger, a grant on `vault`, and a member with that grant. */
const CALLERS: Array<[string, Record<string, unknown> | null]> = [
  ['none', null],
  ['reader', { identity: ['member:alice-example'], hidePrivate: true }],
  ['stranger', { identity: ['member:bob-example'], hidePrivate: true }],
  ['granted', { privateReadableSources: ['vault'], hidePrivate: true }],
  ['readerGranted', { identity: ['member:alice-example'], privateReadableSources: ['vault'], hidePrivate: true }],
];

async function asEach<T>(read: () => Promise<T>): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const [name, access] of CALLERS) out[name] = access ? await withCallerAccess(access, read) : await read();
  return out;
}

describe('engine parity: core-memory page list for a member caller', () => {
  parityTest(
    'listCorePageRows under excludePrivate lists the core pages the caller policy shows, and the floor for any caller',
    { methods: ['putPage', 'listCorePageRows'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'team');
      await createSource(engine, backend, 'vault');
      await engine.putPage('core/open', core({}), { sourceId: 'default' });
      await engine.putPage('core/listed', core({ readable_by: ['alice-example'] }), { sourceId: 'team' });
      await engine.putPage('core/secret', core({ visibility: 'private' }), { sourceId: 'vault' });
      const slugs = async (forCaller: boolean) =>
        (await engine.listCorePageRows({ excludePrivate: true, forCaller, limit: 50 })).map(r => `${r.source_id}:${r.slug}`);
      const out = await asEach(async () => ({ caller: await slugs(true), floor: await slugs(false) }));
      const floor = ['default:core/open'];
      expect(out).toEqual({
        none: { caller: ['default:core/open'], floor },
        reader: { caller: ['default:core/open', 'team:core/listed'], floor },
        stranger: { caller: ['default:core/open'], floor },
        granted: { caller: ['default:core/open', 'vault:core/secret'], floor },
        readerGranted: { caller: ['default:core/open', 'team:core/listed', 'vault:core/secret'], floor },
      });
      return out;
    },
  );
});

describe('engine parity: gbrain core remove', () => {
  // `core remove` un-cores the page on every engine and prints the same line. An engine with raw SQL (PGLite, Postgres)
  // also closes the page's pending remote-edit notices; a Rust brain keeps no notices, so there is nothing to close and
  // the close is skipped. The notice rows are only read where the engine has them, so the returned value is the same on
  // every arm.
  parityTest('core remove un-cores the page and prints the same line on every engine, closing pending notices where they are kept', {
    methods: ['putPage', 'readPageSnapshot'],
  }, async (engine: BrainEngine, backend) => {
    await engine.putPage('core/about', core({}), { sourceId: 'default' });
    await engine.putPage('core/other', core({}), { sourceId: 'default' });
    const keepsNotices = backend !== 'rust';
    const notice = (slug: string) => engine.executeRaw(
      `INSERT INTO core_edit_notices (source_id, slug, page_id, revision, base_revision, base_text, actor) VALUES ('default', $1, NULL, 'rev-1', NULL, 'before', 'agent:test')`, [slug]);
    if (keepsNotices) { await notice('core/about'); await notice('core/other'); }
    const pending = async (slug: string) => (await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM core_edit_notices WHERE source_id = 'default' AND slug = $1 AND acked_at IS NULL`, [slug]))[0]?.n;
    const isCore = async () => (await engine.readPageSnapshot('core/about', { sourceId: 'default' }))?.page.frontmatter?.always_load === true;
    const errors: string[] = [];
    const printed: string[] = [];
    const error = console.error;
    const log = console.log;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    console.log = (...a: unknown[]) => { printed.push(a.join(' ')); };
    let refused: unknown = null;
    try {
      await runCore(engine, ['remove', 'core/about']);
    } catch (e) {
      refused = e;
    } finally {
      console.error = error;
      console.log = log;
    }
    if (keepsNotices) {
      // The page's notice is closed; another page's notice stays pending.
      expect({ closed: await pending('core/about'), other: await pending('core/other') }).toEqual({ closed: 0, other: 1 });
    }
    const out = { refused, core: await isCore(), errors, printed };
    expect(out.refused).toBeNull();
    expect(out).toEqual({ refused: null, core: false, errors: [], printed: [expect.stringMatching(/^Now out of core: default:core\/about\. Core uses \d+\/\d+ chars\.$/)] });
    return out;
  });
});

describe('engine parity: gbrain core add', () => {
  // `core add` marks a live page always_load through the coordinated put_page write, as the brain owner. It prints the
  // same line on every engine and leaves the page core with the priority given.
  parityTest('core add marks the page as core with its priority and prints the same line on every engine', {
    methods: ['putPage', 'readPageSnapshot'],
  }, async (engine: BrainEngine) => {
    await engine.setConfig('memory.core.enabled', 'true');
    await engine.putPage('notes/prefs', { type: 'note' as const, title: 'Prefs', compiled_truth: 'Prefers short answers.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    const errors: string[] = [];
    const printed: string[] = [];
    const error = console.error;
    const log = console.log;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    console.log = (...a: unknown[]) => { printed.push(a.join(' ')); };
    try {
      await runCore(engine, ['add', 'notes/prefs', '--priority', '5']);
    } finally {
      console.error = error;
      console.log = log;
    }
    const fm = (await engine.readPageSnapshot('notes/prefs', { sourceId: 'default' }))?.page.frontmatter as Record<string, unknown> | undefined;
    const out = { core: fm?.always_load === true, priority: fm?.core_priority ?? null, errors, printed };
    expect(out).toEqual({ core: true, priority: 5, errors: [], printed: [expect.stringMatching(/^Now in core: default:notes\/prefs\. Core uses \d+\/\d+ chars\.$/)] });
    return out;
  });
});

describe('engine parity: a remote edit of a core page under remote_edit notify', () => {
  // The default policy lets a remote caller edit a core page and records a notice for the owner (core_edit_notices). A Rust
  // brain keeps no such table, so the write's notice step (core-guard.ts record()) refuses `raw_sql` at publication: the page
  // stays as it was and the write does not commit. PGLite and Postgres commit the edit and write the notice row.
  parityTest('a remote edit of a core page under remote_edit notify commits and records a notice; a Rust brain refuses it and changes nothing', {
    methods: ['putPage', 'readPageSnapshot'], requires: 'raw_sql',
  }, async (engine: BrainEngine, backend) => {
    await engine.putPage('core/about', core({}), { sourceId: 'default' });
    const snapshot = async () => {
      const snap = await engine.readPageSnapshot('core/about', { sourceId: 'default' });
      return { body: snap?.page.compiled_truth ?? null, revision: snap?.revision ?? null };
    };
    const before = await snapshot();
    const home = mkdtempSync(join(tmpdir(), 'gb-core-notify-'));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
        try {
          const auth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default' };
          const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'edit_page', {
            slug: 'core/about', expected_revision: before.revision, edits: [{ old_text: `body ${JSON.stringify({})}`, new_text: 'body edited remotely' }], request_id: randomUUID(),
          }, { remote: true, config: { engine: backend === 'rust' ? 'rust' : 'pglite' }, sourceId: 'default', auth, logger: { info() {}, warn() {}, error() {} } } as never));
          const body = JSON.parse((response.content[0] as { text: string }).text) as Record<string, unknown>;
          const after = await snapshot();
          if (backend === 'rust') {
            // Today's refusal: the notice step of the publication (core-guard.ts record()) runs a raw INSERT into core_edit_notices,
            // which a Rust brain refuses by name. The write ends failed (three claims) and the page is as it was.
            expect({
              isError: response.isError === true, error: body.error, code: body.code, reason: body.reason, detail: body.detail,
              message: String(body.message).startsWith("This brain's engine does not support executeRaw yet (it needs the raw_sql capability)"),
              state: (body.write_request as { state?: string } | undefined)?.state, unchanged: after,
            }).toEqual({
              isError: true, error: 'engine_capability_missing', code: 'engine_capability_missing', reason: 'raw_sql',
              detail: 'member=executeRaw capability=raw_sql outcome=none written=nothing', message: true, state: 'failed', unchanged: before,
            });
            throw body;
          }
          const notices = (await engine.executeRaw<{ actor: string }>(`SELECT actor FROM core_edit_notices WHERE source_id = 'default' AND slug = 'core/about' AND acked_at IS NULL`)).length;
          const out = { isError: response.isError === true, changed: after.body !== before.body, notices };
          expect(out).toEqual({ isError: false, changed: true, notices: 1 });
          return out;
        } finally { await disposePersistenceConsumer(engine); }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
