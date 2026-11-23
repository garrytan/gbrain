/**
 * Engine parity for the reads a page write makes before admission (persistence/page-mutations.ts): the source's local
 * path a `capture --file` judges the file by, the stored type, tier, title and frontmatter a quoted put_page is
 * unquoted against, and the version's file a revert on an unclaimed rooted source is judged by.
 *
 * Fail-first: on rust-engine/page-mutation-reads' base e4420913f5 case 1 fails on every arm (readStoredPageHead and
 * readVersionSourcePath did not exist), and the write cases fail on the Rust arm (each read was an `executeRaw`, which
 * the Rust engine refuses, so the write stopped before admission).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) the members: `readSourceLocalPath` answers a source's local path, null for a source without one or
 *    no such source; `readStoredPageHead` answers the stored type, tier, title and frontmatter of a page by source and
 *    slug, a soft-deleted one too, and null for no such page; `readVersionSourcePath` answers a version's file only
 *    for its own page; (2) a remote put_page of a page's own quoted read writes the body without the quote fence, on
 *    every arm (the legacy token write grant is served on Rust since batch 10); (3) a
 *    trusted `capture` of a local file outside any source root commits as `cli-file`; (4) a revert_version on an
 *    unclaimed rooted source whose current revision has no file is judged by the version's file: file-backed, it
 *    claims the source and commits on PGLite (Postgres refuses owner_unavailable until a writer claims it, as
 *    bench-save-repro case 1); SQL arms only, since no typed member clears a page's file.
 *  - Regression: the three reads were `executeRaw` calls in page-mutations.ts; the Rust engine refuses raw SQL, so a
 *    quoted put_page, a capture of a file and a revert on an unclaimed rooted source failed there before admission.
 *  - Why existing coverage misses it: test/search-transcript-quote-*.test.ts and test/capture-*.test.ts run on PGLite
 *    only, and no parity case wrote a page through these paths.
 *  - Seam: none. Real engines and the put_page/capture/revert_version operation handlers.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { fenceTranscriptText } from '../../src/core/search/transcript-quote.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { randomUUID } from 'node:crypto';

const { parityTest } = parityArms(testBackends());

const ctxFor = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, remote: false as const, writeWaitMs: 8000,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } });
/** One operation call; a refusal is answered as its code so the compared value says what went wrong. */
const run = async (engine: BrainEngine, name: string, params: Record<string, unknown>, sourceId = 'default') => {
  try {
    const r = await operations.find(o => o.name === name)!.handler(ctxFor(engine, sourceId) as never, params) as Record<string, unknown>;
    return { ok: true, state: r.state ?? null, status: r.status ?? null };
  } catch (error) {
    const out = { ok: false, code: (error as { code?: string }).code ?? String(error), detail: (error as { detail?: string }).detail ?? null };
    thrown.set(out, error);
    return out;
  }
};
/** The error each refused `run` caught, kept off the compared value. */
const thrown = new WeakMap<object, unknown>();
/**
 * A re-put of an existing page versions it with the `preimage` option, which the Rust createVersion member does not
 * serve yet (bench-save-repro case 2, another lane). Until it does, the Rust arm ends on that typed refusal, which
 * comes after the reads this file covers; a refusal naming executeRaw is the regression.
 */
const preimageOnRust = (backend: string, out: { ok: boolean; code?: unknown; detail?: unknown }) => backend === 'rust' && out.ok === false
  && out.code === 'engine_capability_missing' && String(out.detail).startsWith('member=createVersion (option preimage)');
const COMMITTED = { ok: true, state: 'committed', status: 'created_or_updated' };
const frontmatterOf = (value: unknown) => typeof value === 'string' ? JSON.parse(value) as unknown : value;

describe('the reads a page write makes before admission', () => {
  parityTest('the members: a source local path, a stored page head (soft-deleted too) and a version file of its own page', {
    methods: ['readSourceLocalPath', 'readStoredPageHead', 'readVersionSourcePath', 'putPage', 'createVersion', 'softDeletePage'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'rooted-example', {}, '/srv/brains/rooted-example');
    const slug = 'notes/head-example';
    const page = await engine.putPage(slug, { type: 'note', title: 'Head example', compiled_truth: 'A body for the head read.', timeline: '',
      frontmatter: { mood: 'calm', tags: ['alpha'] }, source_path: 'notes/head-example.md' });
    const version = await engine.createVersion(slug);
    const head = await engine.readStoredPageHead('default', slug);
    await engine.softDeletePage(slug);
    const deletedHead = await engine.readStoredPageHead('default', slug);
    const shape = (h: typeof head) => h && { type: h.type, trust_tier: h.trust_tier, title: h.title, frontmatter: frontmatterOf(h.frontmatter) };
    const out = {
      localPaths: [await engine.readSourceLocalPath('rooted-example'), await engine.readSourceLocalPath('default'),
        await engine.readSourceLocalPath('no-such-source')],
      head: shape(head), deletedHead: shape(deletedHead), missing: await engine.readStoredPageHead('default', 'notes/no-such-page'),
      otherSource: await engine.readStoredPageHead('rooted-example', slug),
      versionFile: await engine.readVersionSourcePath(Number(version.id), Number(page.id)),
      otherPage: await engine.readVersionSourcePath(Number(version.id), Number(page.id) + 1000),
      missingVersion: await engine.readVersionSourcePath(2_000_000_000, Number(page.id)),
    };
    expect({ ...out, head: out.head && { type: out.head.type, title: out.head.title, frontmatter: out.head.frontmatter } }).toEqual({
      ...out, localPaths: ['/srv/brains/rooted-example', null, null],
      head: { type: 'note', title: 'Head example', frontmatter: { mood: 'calm', tags: ['alpha'] } }, deletedHead: out.head,
      missing: null, otherSource: null, versionFile: 'notes/head-example.md', otherPage: null, missingVersion: null,
    });
    return out;
  });

  parityTest('a remote put_page of a page\'s own quoted read reads the stored head before admission', {
    methods: ['readStoredPageHead', 'getPage'],
  }, async (engine) => {
    // Only a remote put_page is unquoted (page-mutations.ts unquotedPutContent), and it reads the stored head before
    // admission. Every arm admits a legacy-token write and stores the body without the fence. Before this change the
    // Rust arm refused at the read itself (engine_capability_missing, member=executeRaw); since the legacy token write
    // grant is served on Rust too (lane 2's token members, batch 10), the Rust arm commits like the SQL arms.
    try {
      const slug = 'notes/quoted-example';
      const head = '---\ntype: note\ntitle: Quoted example\n---\n\n';
      const created = await run(engine, 'put_page', { slug, content: `${head}The first body.\n` });
      const minted = await mintLegacyToken(engine, { name: `parity-${randomUUID()}`, scopes: ['read', 'write'], sourceGrant: ['default'], takesHolders: ['world'] });
      const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      const opts = { remote: true, transport: 'http', sourceId: 'default', admissionOrigin: 'interactive', takesHoldersAllowList: ['world'],
        auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id }, sourceId: 'default', allowedSources: ['default'], scopes: ['read', 'write'] } };
      const result = await dispatchToolCall(engine, 'put_page', { slug, content: `${head}${fenceTranscriptText('The second body.\n', slug)}`,
        expected_revision: current?.revision, request_id: randomUUID() }, opts as never);
      const reply = JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown> | null;
      const page = await engine.getPage(slug, { sourceId: 'default' });
      const out = { created, isError: result.isError === true, error: reply?.error ?? null, body: page?.compiled_truth ?? null };
      expect(out).toEqual({ created: COMMITTED, isError: false, error: null, body: 'The second body.' });
      return out;
    } finally { await disposePersistenceConsumer(engine); }
  });

  parityTest('a trusted capture of a local file outside any source root commits as cli-file', { methods: ['readSourceLocalPath', 'getPage'] }, async (engine) => {
    try {
      const slug = 'inbox/capture-example';
      const captured = await run(engine, 'capture', { slug, content: 'A captured observation from a local file.', local_file: '/srv/outside/capture-example.md' });
      const page = await engine.getPage(slug, { sourceId: 'default' });
      const out = { captured, stored: page !== null, keepsText: String(page?.compiled_truth ?? '').includes('A captured observation from a local file.') };
      expect(out).toEqual({ captured: COMMITTED, stored: true, keepsText: true });
      return out;
    } finally { await disposePersistenceConsumer(engine); }
  });

  parityTest('a revert_version on an unclaimed rooted source is judged by the version file', {
    methods: ['readVersionSourcePath', 'putPage', 'createVersion', 'getWorktreeBinding'],
    requires: 'raw_sql',
    timeout: 60_000,
  }, async (engine, backend) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-page-mutation-reads-')));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const root = join(home, 'vault');
        mkdirSync(join(root, 'notes'), { recursive: true });
        execFileSync('git', ['-C', root, 'init', '-q']);
        // The committed file matches the current revision, so the revert passes the file-drift check.
        writeFileSync(join(root, 'notes', 'revert-example.md'), '---\ntitle: Revert example\ntype: note\n---\nThe second body.\n');
        execFileSync('git', ['-C', root, 'add', '.']);
        execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
        await createSource(engine, backend, 'vault', {}, root);
        const slug = 'notes/revert-example';
        // The page and its version are stored directly, so the source stays unclaimed until the revert.
        await engine.putPage(slug, { type: 'note', title: 'Revert example', compiled_truth: 'The first body.', timeline: '',
          frontmatter: {}, source_path: 'notes/revert-example.md' }, { sourceId: 'vault' });
        const version = await engine.createVersion(slug, { sourceId: 'vault' });
        await engine.putPage(slug, { type: 'note', title: 'Revert example', compiled_truth: 'The second body.', timeline: '',
          frontmatter: {}, source_path: 'notes/revert-example.md' }, { sourceId: 'vault' });
        // The current revision has no file, so only the version's file makes the revert file-backed (the read this covers).
        // No typed member clears a page's file, so the SQL arms seed it; the Rust arm stops here on raw_sql (case 1
        // proves its readVersionSourcePath).
        await engine.executeRaw("UPDATE pages SET source_path=NULL WHERE source_id='vault' AND slug=$1", [slug]);
        try {
          const current = await engine.readPageSnapshot(slug, { sourceId: 'vault' });
          const reverted = await run(engine, 'revert_version', { slug, version_id: Number(version.id), expected_revision: current?.revision }, 'vault');
          // File-backed by its version, the revert claims the unclaimed rooted source and writes the file; a revert judged
          // database-only would leave the source unclaimed. Postgres is a multi-process engine: an unclaimed rooted
          // source refuses until a writer claims it (#6608), and its revert is judged the same way first.
          const seen = { reverted: reverted.ok ? { ok: true, state: (reverted as { state?: unknown }).state } : { ok: false, code: (reverted as { code?: string }).code },
            claimed: (await getWorktreeBinding(engine, 'vault')) !== null };
          expect(seen).toEqual(backend === 'postgres' ? { reverted: { ok: false, code: 'owner_unavailable' }, claimed: false }
            : { reverted: { ok: true, state: 'committed' }, claimed: true });
          return { followedItsEngineRule: true };
        } finally { await disposePersistenceConsumer(engine); }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
